/* eslint-disable */
/** @odoo-module **/

import { Component, onMounted, onWillUnmount, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

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

    const buttonish = el.closest?.(
        "button,[role='button'],.o-kanban-button,.o_statusbar_button"
    );
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
        headerCells = headerRow
            ? Array.from(headerRow.cells || [])
            : Array.from(thead.querySelectorAll("th"));
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
    let best = null,
        bestScore = -1;
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
        const rid =
            row.getAttribute?.("data-res-id") ||
            row.getAttribute?.("data-id") ||
            row.dataset?.id;
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
    if (!labelEl && el.parentElement)
        labelEl = el.parentElement.querySelector?.("label") || null;
    if (!labelEl) {
        const wrap = el.closest?.(
            ".form-check, .custom-control, .o_boolean_toggle, .o_setting_box, .o_form_label"
        );
        if (wrap) {
            labelEl =
                wrap.querySelector?.(
                    ".form-check-label, .custom-control-label, label, .o_form_label, .o_setting_label"
                ) || null;
        }
    }
    if (!labelEl && el.nextElementSibling?.tagName === "LABEL")
        labelEl = el.nextElementSibling;
    if (!labelEl && el.previousElementSibling?.tagName === "LABEL")
        labelEl = el.previousElementSibling;

    const txt =
        cleanText(labelEl?.textContent || el.getAttribute?.("title") || "") || "";
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
            const tail =
                href
                    .split(/[\/#?]/)
                    .filter(Boolean)
                    .slice(-1)[0] || href;
            return `Link-${tail}`;
        }
    }

    const uid = ensureElementUid(el) || Math.floor(Math.random() * 1e9);
    return `${uiType}-${uid}`;
}

class AiFloatingButton extends Component {
    static template = "ai_chat.AiFloatingButton";

    setup() {
        this.actionService = useService("action");
        this.contextService = useService("context_service");

        this.state = useState({
            showButton: false,
            logs: [],
            ctx: { viewType: null, resId: null },
        });

        this.ws = null;
        this.wsConnected = false;

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
        ];

        onMounted(() => {
            this._connectWebSocket();

            this.intervalId = setInterval(() => {
                if (this.state.logs.length) {
                    const c = this.state.ctx || {};
                    //console.log("User activity logs:", this.state.logs);
                    //console.log(`[ctx] view=${c.viewType || "-"} id=${c.resId || "-"}`);
                }
            }, 10000);
        });

        this._interval = setInterval(() => {
            let currentModel = null,
                showButton = false;
            const currentAction = this.actionService.currentController?.props;
            if (currentAction) {
                currentModel = currentAction.resModel;
                if (this.modules.includes(currentModel)) showButton = true;
            }
            this.state.showButton = showButton;

            const currentPath2 = window.location.pathname;
            const isCreatingSaleOrder = currentPath2 === "/odoo/sales/new";
            if (isCreatingSaleOrder)
                this.contextService.setContext(currentModel, "form", "create");
            else if (currentModel)
                this.contextService.setContext(currentModel, "form", "list");

            this.state.ctx = this._getContextSnapshot();
        }, 500);

        onWillUnmount(() => {
            if (this.intervalId) clearInterval(this.intervalId);
        });

        // CLICK
        document.addEventListener(
            "click",
            (ev) => {
                if (!ev.target || !ev.target.tagName) return;
                const base = this._getContextSnapshot();

                const link = ev.target.closest?.(
                    "a, [role='menuitem'], .o_app, .o_menuitem, .dropdown-item"
                );
                let href = null,
                    menuXmlid = null;
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

                this.addLog("click", {
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
                    label,
                    labelKey,
                    ...gctx,
                    ...base,
                });

                setTimeout(() => {
                    this.addLog("route_after", this._getContextSnapshot());
                }, 0);
            },
            true
        );

        // INPUT (teclas)
        document.addEventListener(
            "input",
            (ev) => {
                if (
                    !ev.target ||
                    !["INPUT", "TEXTAREA"].includes(ev.target.tagName)
                )
                    return;
                const base = this._getContextSnapshot();
                const uiType = classifyElement(ev.target);
                const gctx = findGridContext(ev.target);
                const label = getControlLabel(ev.target);
                const labelKey = label ? `${uiType}-${slugify(label)}` : null;
                const uniqueKey = buildUniqueKey(ev.target, uiType, gctx);

                this.addLog("input", {
                    name: ev.target.name,
                    value: (ev.target.value ?? "").toString().slice(0, 80),
                    tag: ev.target.tagName,
                    className: ev.target.className,
                    idAttr: ev.target.id || null,
                    role: ev.target.getAttribute?.("role") || null,
                    title: ev.target.getAttribute?.("title") || null,
                    uiType,
                    uniqueKey,
                    label,
                    labelKey,
                    ...gctx,
                    ...base,
                });
            },
            true
        );

        // CHANGE (valor final input)
        document.addEventListener(
            "change",
            (ev) => {
                if (
                    !ev.target ||
                    !["INPUT", "TEXTAREA", "SELECT"].includes(ev.target.tagName)
                )
                    return;

                const base = this._getContextSnapshot();
                const uiType = classifyElement(ev.target);
                const gctx = findGridContext(ev.target);
                const label = getControlLabel(ev.target);
                const labelKey = label ? `${uiType}-${slugify(label)}` : null;
                const uniqueKey = buildUniqueKey(ev.target, uiType, gctx);

                this.addLog("input_final", {
                    name: ev.target.name,
                    value: (ev.target.value ?? "").toString().slice(0, 80),
                    tag: ev.target.tagName,
                    className: ev.target.className,
                    idAttr: ev.target.id || null,
                    role: ev.target.getAttribute?.("role") || null,
                    title: ev.target.getAttribute?.("title") || null,
                    uiType,
                    uniqueKey,
                    label,
                    labelKey,
                    ...gctx,
                    ...base,
                });
            },
            true
        );

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
                    if (!r.includes(String(rowLabelContains).toLowerCase()))
                        continue;
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
                if (
                    preferTag &&
                    (e.tag || "").toUpperCase() === String(preferTag).toUpperCase()
                )
                    score += 2;
                if (preferUiType && e.uiType === preferUiType) score += 1.5;
                const ts = Date.parse(e.timestamp || "") || 0;
                if (ts) {
                    const ageMs = Date.now() - ts;
                    const rec = Math.max(
                        0,
                        1 - Math.min(ageMs / (5 * 60 * 1000), 1)
                    );
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
            const props = this.actionService.currentController?.props || {};
            const hash = parseHashParams();
            const query = parseQueryParams();
            const getNum = (x) =>
                x != null && x !== "" && !Number.isNaN(Number(x)) ? Number(x) : null;

            return {
                viewType:
                    props.viewType ||
                    hash.view_type ||
                    query.view_type ||
                    guessViewType(),
                resId:
                    getNum(props.resId) || getNum(hash.id) || getNum(query.id),
            };
        } catch {
            return { viewType: null, resId: null };
        }
    }

    _exposeWsBridge() {
        // cola global para eventos cuando el ws aún no está listo
        window.__AI_TUTOR_WS_QUEUE = window.__AI_TUTOR_WS_QUEUE || [];

        // función global para que otros módulos puedan enviar
        window.aiTutorSend = (payload) => {
            try {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
                    this.ws.send(msg);
                    return true;
                }
                // si no está listo, lo encolamos
                window.__AI_TUTOR_WS_QUEUE.push(payload);
                return false;
            } catch (e) {
                console.error("[AI tutor] aiTutorSend failed:", e);
                return false;
            }
        };
    }

    _flushWsQueue() {
        const q = window.__AI_TUTOR_WS_QUEUE || [];
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        while (q.length) {
            const payload = q.shift();
            try {
                const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
                this.ws.send(msg);
            } catch (e) {
                console.error("[AI tutor] flush ws queue error:", e);
                break;
            }
        }
    }

    _connectWebSocket() {
        try {
            const baseUrl = "wss://tutor-backend.odooconcept.com/ws"; //TODO: Use a variable so that it can be modified from settings or parameters
            const params = new URLSearchParams();

            const sess = (window.odoo && odoo.session_info) || {};
            if (sess.session_id) params.set("session_id", sess.session_id);
            if (sess.username) params.set("user_login", sess.username);
            if (sess.db) params.set("db", sess.db);

            const fullUrl = params.toString() ? `${baseUrl}?${params.toString()}` : baseUrl;

            console.log("[AI tutor] Connecting WebSocket:", fullUrl);
            this.ws = new WebSocket(fullUrl);

            // ✅ Exponer puente global apenas creas el ws
            this._exposeWsBridge();

            this.ws.onopen = () => {
                this.wsConnected = true;
                console.log("[AI tutor] WebSocket connected");

                // ✅ flush de lo que se haya intentado enviar antes de conectar
                this._flushWsQueue();
            };

            this.ws.onmessage = (ev) => {
                console.log("[AI tutor] WebSocket message:", ev.data);
            };
            this.ws.onerror = (err) => {
                console.error("[AI tutor] WebSocket error:", err);
            };
            this.ws.onclose = (ev) => {
                this.wsConnected = false;
                console.warn("[AI tutor] WebSocket closed:", ev.code, ev.reason);

                // deja la función global “viva” pero en modo queue
                window.aiTutorSend = (payload) => {
                    window.__AI_TUTOR_WS_QUEUE = window.__AI_TUTOR_WS_QUEUE || [];
                    window.__AI_TUTOR_WS_QUEUE.push(payload);
                    return false;
                };
            };
        } catch (err) {
            console.error("[AI tutor] WebSocket connection failed:", err);
        }
    }

    addLog(type, data) {
        const ev = { type, ...data, timestamp: new Date().toISOString() };

        if (this.state.logs.length > 1000) {
            this.state.logs.splice(0, this.state.logs.length - 1000);
        }
        this.state.logs.push(ev);

        if (ev.type === "click" && ev.uiType === "Button") {
            this._sendButtonEvent(ev);
        }

        if (ev.type === "input_final") {
            this._sendInputEvent(ev);
        }

        return ev;
    }

    _sendButtonEvent(ev) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn(
                "[AI tutor] WebSocket not ready, cannot send ui_event (button)",
                ev
            );
            return;
        }

        const buttonId =
            ev.uniqueKey ||
            ev.nameAttr ||
            ev.idAttr ||
            (ev.text && slugify(ev.text)) ||
            "unknown_button";

        const payload = {
            type: "ui_event",
            event_name: "button_click",
            event_data: {
                button_id: buttonId,
                timestamp: ev.timestamp,
                raw: ev,
            },
        };

        this.ws.send(JSON.stringify(payload));
        console.log("[AI tutor] ui_event sent:", payload);
    }

    _sendInputEvent(ev) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn(
                "[AI tutor] WebSocket not ready, cannot send ui_event (input)",
                ev
            );
            return;
        }

        const fieldId =
            ev.name ||
            ev.columnField ||
            ev.labelKey ||
            ev.uniqueKey ||
            "unknown_input";

        const payload = {
            type: "ui_event",
            event_name: "input_change",
            event_data: {
                field_id: fieldId,
                value: ev.value,
                timestamp: ev.timestamp,
                raw: ev,
            },
        };

        this.ws.send(JSON.stringify(payload));
        console.log("[AI tutor] input_change sent:", payload);
    }

    willUnmount() {
        clearInterval(this._interval);
        if (this.intervalId) clearInterval(this.intervalId);
        if (this.ws) {
            try {
                this.ws.close();
            } catch (e) {}
            this.ws = null;
            this.wsConnected = false;
        }
    }
}

registry.category("main_components").add(
    "AiFloatingButton",
    { Component: AiFloatingButton },
    { sequence: 100 }
);
