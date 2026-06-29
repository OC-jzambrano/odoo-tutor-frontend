/* eslint-disable */
/** @odoo-module **/

import { Component, onMounted, onWillUnmount, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { rpc } from "@web/core/network/rpc";
import { _t } from "@web/core/l10n/translation";
import { detectActiveViewType, normalizeDomEvent } from "../normalize_event";
import { normalizePersistentRecordId } from "../record_id";
import "../action_service_context_hook";

// ---------------------
// Helpers
// ---------------------

const AI_DOC = window.top?.document || document;
const EXERCISE_CTA_STATE_KEY = "__AI_TUTOR_EXERCISE_CTA__";
const EXERCISE_CTA_EVENT = "ai:exercise_cta_update";
const EXERCISE_CHOICE_EVENT = "ai:exercise_choice";
const SIDEBAR_CLOSED_EVENT = "ai:sidebar_closed";
const OWL_NAVIGATION_VISIBILITY_GRACE_MS = 1800;

function normalizePreviewTimestamp(ts) {
    const now = Date.now();

    if (!ts) {
        return new Date(now).toISOString();
    }

    let parsed = NaN;

    if (typeof ts === "number") {
        parsed = ts < 1e12 ? ts * 1000 : ts;
    } else {
        const raw = String(ts).trim();

        if (/^\d+(\.\d+)?$/.test(raw)) {
            const n = Number(raw);
            parsed = n < 1e12 ? n * 1000 : n;
        } else {
            parsed = new Date(raw).getTime();
        }
    }

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return new Date(now).toISOString();
    }

    if (parsed > now + 5 * 60 * 1000) {
        return new Date(now).toISOString();
    }

    if (parsed < now - 30 * 24 * 60 * 60 * 1000) {
        return new Date(now).toISOString();
    }

    return new Date(parsed).toISOString();
}

function cleanPreviewText(text) {
    return (text || "")
        .toString()
        .replace(/\*\*/g, "")
        .replace(/\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function translateKnownTutorText(value) {
    const cleaned = cleanPreviewText(value);
    const normalized = cleaned
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .replace(/\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    if (normalized === "do you want to continue the exercise?") {
        return _t("Do you want to continue the exercise?");
    }

    return cleaned;
}

function formatTimeAgo(ts) {
    if (!ts) return "";
    const now = Date.now();
    const then = new Date(ts).getTime();
    if (!Number.isFinite(then)) return "";

    const diffSec = Math.max(0, Math.floor((now - then) / 1000));

    if (diffSec < 10) return _t("just now");
    if (diffSec < 60) return _t("%s seconds ago", diffSec);

    const diffMin = Math.floor(diffSec / 60);
    if (diffMin === 1) return _t("1 minute ago");
    if (diffMin < 60) return _t("%s minutes ago", diffMin);

    const diffHour = Math.floor(diffMin / 60);
    if (diffHour === 1) return _t("1 hour ago");
    if (diffHour < 24) return _t("%s hours ago", diffHour);

    const diffDay = Math.floor(diffHour / 24);
    if (diffDay === 1) return _t("1 day ago");
    return _t("%s days ago", diffDay);
}

function getOwlPreviewState() {
    window.__AI_TUTOR_OWL_PREVIEW__ = window.__AI_TUTOR_OWL_PREVIEW__ || {
        message: "",
        timestamp: null,
        visible: false,
    };
    return window.__AI_TUTOR_OWL_PREVIEW__;
}

function getExerciseCtaState() {
    window[EXERCISE_CTA_STATE_KEY] = window[EXERCISE_CTA_STATE_KEY] || {
        exerciseId: null,
        visible: false,
        status: "",
        updatedAt: null,
    };
    return window[EXERCISE_CTA_STATE_KEY];
}

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
        const th = table.querySelector(`thead th[aria-colindex="${aria}"]`);
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
    let best = null;
    let bestScore = -1;
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
        out.rowId = normalizePersistentRecordId(rid);

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
            labelEl = document.querySelector(`label[for="${sel}"]`);
        } catch {
            labelEl = document.querySelector(`label[for="${id}"]`);
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
    static props = {};

    setup() {
        this.actionService = useService("action");
        this.contextService = useService("context_service");
        this._lastActiveListField = null;
        this._dragJustEndedAt = 0;
        this._boundDragMove = null;
        this._boundDragEnd = null;
        this._previewDismissed = false;

        this.aiWs = useService("ai_ws");
        this.aiRecorder = useService("ai_recorder");

        this._dragState = null;
        this._dragPos = { x: 0, y: 0 };
        this._suppressNextClick = false;
        this._rafDrag = null;
        this._showButtonGraceUntil = 0;

        this.state = useState({
            showButton: false,
            chatOpen: false,
            dragging: false,
            dragX: 0,
            dragY: 0,
            logs: [],
            ctx: { viewType: null, resId: null },
            previewMessage: "",
            previewTimestamp: null,
            previewVisible: false,
            previewTick: Date.now(),
            exerciseCtaVisible: false,
            exerciseCtaId: null,
            exerciseCtaStatus: "",
        });

        const previewState = getOwlPreviewState();
        const exerciseCtaState = getExerciseCtaState();

        this.state.previewMessage = previewState.message || "";
        this.state.previewTimestamp = previewState.timestamp || null;
        this.state.previewVisible = !!previewState.visible;
        this.state.exerciseCtaVisible = !!exerciseCtaState.visible;
        this.state.exerciseCtaId = exerciseCtaState.exerciseId || null;
        this.state.exerciseCtaStatus = exerciseCtaState.status || "";

        this._syncPreviewState = () => {
            previewState.message = this.state.previewMessage;
            previewState.timestamp = this.state.previewTimestamp;
            previewState.visible = this.state.previewVisible;
        };

        this._applyExerciseCtaState = (data = getExerciseCtaState()) => {
            const visible = !!data.visible && !!data.exerciseId;
            this.state.exerciseCtaVisible = visible;
            this.state.exerciseCtaId = visible ? data.exerciseId : null;
            this.state.exerciseCtaStatus = visible ? data.status || "" : "";

            if (visible && this.state.previewMessage) {
                const offcanvasEl = document.getElementById("offcanvasAiSidebar");
                const isChatOpen = this.state.chatOpen || !!offcanvasEl?.classList?.contains("show");
                this._previewDismissed = false;
                this.state.previewVisible = !isChatOpen;
                this._syncPreviewState?.();
            }
        };

        this._setPreviewMessage = (text, timestamp) => {
            const cleaned = translateKnownTutorText(text);
            if (!cleaned) return;

            const safeTimestamp = normalizePreviewTimestamp(timestamp);
            this._previewDismissed = false;

            this.state.previewMessage = cleaned;
            this.state.previewTimestamp = safeTimestamp;
            this.state.previewTick = Date.now();

            const offcanvasEl = document.getElementById("offcanvasAiSidebar");
            const isChatOpen = this.state.chatOpen || !!offcanvasEl?.classList?.contains("show");

            this.state.previewVisible = !isChatOpen;
            this._syncPreviewState();
        };

        this._onPreviewMessage = (ev) => {
            const msg = ev?.kind ? ev.data : ev;
            if (!msg || typeof msg !== "object") return;

            if (msg.type === "tutor_push") {
                this._setPreviewMessage(msg.response || "", msg.timestamp);
                return;
            }

            if (
                msg.type === "chat_response_complete" ||
                ev?.kind === "chat_final"
            ) {
                const text = msg.response || msg.message || "";
                this._setPreviewMessage(text, msg.timestamp);
            }
        };

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
            "ir.ui.menu"
        ];

        window.aiTutorDebug = window.aiTutorDebug || {};

        window.aiTutorDebug.showPreview = (text, timestamp = new Date().toISOString()) => {
            this._setPreviewMessage(text, timestamp);
        };

        window.aiTutorDebug.hidePreview = () => {
            this.closePreview();
        };

        onMounted(() => {
            this.aiWs?.ensureConnected?.().catch(() => {});
            this.aiWs?.subscribe?.(this._onPreviewMessage);

            this._restoreWidgetPosition();
            this._syncChatOpenStateFromDom();

            this._onWindowResize = () => {
                this._fixPositionToViewport({ persist: true });
            };
            window.addEventListener("resize", this._onWindowResize, { passive: true });

            this._onPreviewReset = () => {
                this._previewDismissed = false;
                this.state.previewMessage = "";
                this.state.previewTimestamp = null;
                this.state.previewVisible = false;
                this.state.previewTick = Date.now();
                this._syncPreviewState?.();
            };

            window.addEventListener("ai:preview_reset", this._onPreviewReset);

            this._onExerciseCtaUpdate = (e) => {
                this._applyExerciseCtaState(e?.detail || getExerciseCtaState());
            };

            window.addEventListener(EXERCISE_CTA_EVENT, this._onExerciseCtaUpdate);
            this._applyExerciseCtaState(getExerciseCtaState());

            this._onSidebarClosed = () => this._restorePreviewAfterChatClose();
            window.addEventListener(SIDEBAR_CLOSED_EVENT, this._onSidebarClosed);

            this._previewTimer = setInterval(() => {
                if (this.state.previewTimestamp) {
                    this.state.previewTick = Date.now();
                }
            }, 30000);

            this._bindOffcanvasEvents = () => {
                const offcanvasEl = document.getElementById("offcanvasAiSidebar");
                if (!offcanvasEl || this._offcanvasEventsBound) return false;

                this.state.chatOpen = offcanvasEl.classList.contains("show");

                this._onOffcanvasShown = () => {
                    this.state.chatOpen = true;
                    this.state.previewVisible = false;
                    this._suppressNextClick = false;
                    this._syncPreviewState?.();
                    this._focusChatInput();
                };

                this._onOffcanvasHidden = () => this._restorePreviewAfterChatClose();

                offcanvasEl.addEventListener("shown.bs.offcanvas", this._onOffcanvasShown);
                offcanvasEl.addEventListener("hidden.bs.offcanvas", this._onOffcanvasHidden);

                this._offcanvasEventsBound = true;
                return true;
            };

            this._bindOffcanvasEvents();

            this._offcanvasBindTimer = setInterval(() => {
                if (this._bindOffcanvasEvents()) {
                    clearInterval(this._offcanvasBindTimer);
                    this._offcanvasBindTimer = null;
                }
            }, 500);
        });

        this._interval = setInterval(() => {
            this._syncChatOpenStateFromDom();

            let currentModel = null;
            let showButton = false;
            let hasResolvedUnsupportedModel = false;

            const currentAction = this.actionService.currentController?.props;
            const isHomeMenu = this._isHomeMenu();
            const now = Date.now();

            if (isHomeMenu) {
                currentModel = "ir.ui.menu";
                showButton = true;
            } else if (currentAction) {
                currentModel = currentAction.resModel || null;

                if (this.modules.includes(currentModel)) {
                    showButton = true;
                } else if (currentModel) {
                    hasResolvedUnsupportedModel = true;
                }
            }

            if (this.state.exerciseCtaVisible) {
                showButton = true;
            }

            if (showButton) {
                this._showButtonGraceUntil = now + OWL_NAVIGATION_VISIBILITY_GRACE_MS;
            } else if (
                this.state.showButton &&
                !hasResolvedUnsupportedModel &&
                now < this._showButtonGraceUntil
            ) {
                showButton = true;
            } else {
                this._showButtonGraceUntil = 0;
            }

            this.state.showButton = showButton;

            const currentPath2 = window.location.pathname;
            const isCreatingSaleOrder = currentPath2 === "/odoo/sales/new";

            if (isHomeMenu) {
                this.contextService.setContext("ir.ui.menu", "home_menu", "launcher");
            } else if (isCreatingSaleOrder) {
                this.contextService.setContext(currentModel, "form", "create");
            } else if (currentModel) {
                const activeViewType = detectActiveViewType();
                this.contextService.setContext(
                    currentModel,
                    activeViewType,
                    activeViewType,
                    currentAction?.resId ?? null
                );
            }

            this.state.ctx = this._getContextSnapshot();
        }, 500);

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
                }
            }
            const base = this._getContextSnapshot();

            const link = ev.target.closest?.("a, [role='menuitem'], .o_app, .o_menuitem, .dropdown-item");
            let href = null;
            let menuXmlid = null;
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
                targetElement,
                label,
                labelKey,
                ...gctx,
                ...base,
            });

            try {
                const rawTarget = ev.target;
                const actionableClick = this._isClearlyActionableClick(rawTarget);

                let normalized = normalizeDomEvent({
                    domEventType: "click",
                    originalEvent: ev,
                    context: this._getContextSnapshot(),
                    hints: {
                        lastActiveField: this._lastActiveListField,
                        actionableEl: this._getActionableTarget(rawTarget),
                    },
                });

                if (normalized && actionableClick) {
                    normalized = this._patchNormalizedWithActionable(normalized, rawTarget);
                }

                if (normalized) {
                    if (!actionableClick && this._shouldIgnoreNormalizedEvent(normalized)) {
                        return;
                    }

                    this.aiWs?.sendEvent?.({
                        type: "ui_event",
                        event_name: normalized.type || "click",
                        event_data: normalized,
                    }).catch(() => {});
                }
            } catch (e) {
                console.warn("[AI_UI] normalize failed", e);
            }

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
                targetElement,
                label,
                labelKey,
                ...gctx,
                ...base,
            });

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
        };

        AI_DOC.addEventListener("click", this._onDocClick, true);
        AI_DOC.addEventListener("input", this._onDocInput, true);
        AI_DOC.addEventListener("change", this._onDocChange, true);

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

    _syncChatOpenStateFromDom() {
        const offcanvasEl = document.getElementById("offcanvasAiSidebar");
        const isOpen = !!offcanvasEl?.classList?.contains("show");

        if (this.state.chatOpen !== isOpen) {
            const wasOpen = this.state.chatOpen;
            this.state.chatOpen = isOpen;
            if (wasOpen && !isOpen) {
                this._restorePreviewAfterChatClose();
            }
        }
    }

    _restorePreviewAfterChatClose() {
        this.state.chatOpen = false;
        this._suppressNextClick = false;

        if (this.state.previewMessage && !this._previewDismissed) {
            this.state.previewVisible = true;
            this.state.previewTick = Date.now();
        } else {
            this.state.previewVisible = false;
        }

        this._syncPreviewState?.();
    }

    _isHomeMenu() {
        const doc = AI_DOC || document;

        const currentAction = this.actionService.currentController?.props || null;
        const hasCurrentModel = !!currentAction?.resModel;

        const hasActionView = !!doc.querySelector(`
            .o_action_manager .o_form_view,
            .o_action_manager .o_list_view,
            .o_action_manager .o_kanban_view,
            .o_action_manager .o_graph_view,
            .o_action_manager .o_pivot_view,
            .o_action_manager .o_calendar_view
        `);

        const hasHomeMenu = !!doc.querySelector(`
            .o_home_menu,
            .o_apps,
            .o_app
        `);

        return hasHomeMenu && !hasActionView && !hasCurrentModel;
    }

    _restoreWidgetPosition() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem("odoo_chat_position") || "null");
        } catch {
            saved = null;
        }

        const fallback = {
            x: Math.max(0, window.innerWidth - 110),
            y: Math.max(0, window.innerHeight - 110),
        };

        const pos = saved &&
            Number.isFinite(saved.x) &&
            Number.isFinite(saved.y)
            ? saved
            : fallback;

        const fixed = this._clampPosition(pos.x, pos.y);
        this._dragPos = fixed;
        this.state.dragX = fixed.x;
        this.state.dragY = fixed.y;
    }

    _persistWidgetPosition() {
        try {
            localStorage.setItem("odoo_chat_position", JSON.stringify({
                x: this._dragPos.x,
                y: this._dragPos.y,
            }));
        } catch {}
    }

    _getDragPoint(ev) {
        if (ev?.touches?.length) return ev.touches[0];
        if (ev?.changedTouches?.length) return ev.changedTouches[0];
        return ev;
    }

    _getWidgetRect() {
        const root = this.el?.querySelector?.(".ai-floating-button");
        if (!root) return { width: 90, height: 90 };

        const rect = root.getBoundingClientRect();
        return {
            width: Math.max(90, Math.ceil(rect.width || root.offsetWidth || 90)),
            height: Math.max(90, Math.ceil(rect.height || root.offsetHeight || 90)),
        };
    }

    _clampPosition(x, y) {
        const { width, height } = this._getWidgetRect();
        const maxX = Math.max(0, window.innerWidth - width);
        const maxY = Math.max(0, window.innerHeight - height);

        return {
            x: Math.max(0, Math.min(x, maxX)),
            y: Math.max(0, Math.min(y, maxY)),
        };
    }

    _fixPositionToViewport({ persist = false } = {}) {
        const fixed = this._clampPosition(this._dragPos.x, this._dragPos.y);
        this._dragPos = fixed;
        this.state.dragX = fixed.x;
        this.state.dragY = fixed.y;

        if (persist) {
            this._persistWidgetPosition();
        }
    }

    noop() {}

    onIconClick(ev) {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();

        const justDragged = Date.now() - (this._dragJustEndedAt || 0) < 250;

        if (this.state.dragging || justDragged || this._suppressNextClick) {
            this._suppressNextClick = false;
            return;
        }

        this.toggleChat();
    }

    onIconDragStart(ev) {
        const point = this._getDragPoint(ev);
        if (!point) return;

        this._dragState = {
            startX: point.clientX,
            startY: point.clientY,
            originX: this._dragPos.x,
            originY: this._dragPos.y,
            moved: false,
            startedAt: Date.now(),
        };

        this._suppressNextClick = false;
        this.state.dragging = true;
        document.body.classList.add("ai-widget-dragging");

        this._boundDragMove = this._boundDragMove || this._onDragMove.bind(this);
        this._boundDragEnd = this._boundDragEnd || this._onDragEnd.bind(this);

        window.addEventListener("mousemove", this._boundDragMove, { passive: false });
        window.addEventListener("mouseup", this._boundDragEnd, { passive: true });
        window.addEventListener("touchmove", this._boundDragMove, { passive: false });
        window.addEventListener("touchend", this._boundDragEnd, { passive: true });
        window.addEventListener("touchcancel", this._boundDragEnd, { passive: true });
    }

    _onDragMove(ev) {
        if (!this._dragState) return;

        const point = this._getDragPoint(ev);
        if (!point) return;

        const dx = point.clientX - this._dragState.startX;
        const dy = point.clientY - this._dragState.startY;

        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
            this._dragState.moved = true;
            this._suppressNextClick = true;
        }

        if (!this._dragState.moved) return;

        ev.preventDefault();

        const next = this._clampPosition(
            this._dragState.originX + dx,
            this._dragState.originY + dy
        );

        this._dragPos = next;
        this.state.dragX = next.x;
        this.state.dragY = next.y;
    }

    _onDragEnd() {
        if (!this._dragState) return;

        const moved = !!this._dragState.moved;

        this.state.dragging = false;
        this._dragState = null;
        document.body.classList.remove("ai-widget-dragging");

        if (this._boundDragMove) {
            window.removeEventListener("mousemove", this._boundDragMove);
            window.removeEventListener("touchmove", this._boundDragMove);
        }
        if (this._boundDragEnd) {
            window.removeEventListener("mouseup", this._boundDragEnd);
            window.removeEventListener("touchend", this._boundDragEnd);
            window.removeEventListener("touchcancel", this._boundDragEnd);
        }

        this._persistWidgetPosition();

        if (moved) {
            this._dragJustEndedAt = Date.now();
            this._suppressNextClick = true;

            setTimeout(() => {
                this._suppressNextClick = false;
            }, 260);
        }
    }

    _isGenericDomRef(value) {
        const v = String(value || "").trim().toLowerCase();
        if (!v) return true;

        return (
            v === "el.unknown" ||
            v.endsWith(".unknown") ||

            v.startsWith("div.") ||
            v.startsWith("span.") ||
            v.startsWith("i.") ||
            v.startsWith("svg.") ||
            v.startsWith("path.") ||
            v.startsWith("label.") ||
            v.startsWith("strong.") ||
            v.startsWith("small.") ||
            v.startsWith("p.") ||
            v.startsWith("ul.") ||
            v.startsWith("li.") ||

            v.includes("o_list_renderer") ||
            v.includes("o_form_view") ||
            v.includes("o_form_renderer") ||
            v.includes("o_kanban_view") ||
            v.includes("o_kanban_renderer") ||
            v.includes("o_content") ||
            v.includes("o_web_client")
        );
    }

    _isSemanticFieldRef(value) {
        const v = String(value || "").trim();
        if (!v) return false;

        if (this._isGenericDomRef(v)) return false;
        return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v);
    }

    _isMeaningfulLabel(value) {
        const v = String(value || "").trim();
        if (!v) return false;
        if (v.length > 80) return false;

        const words = v.split(/\s+/).filter(Boolean);
        if (words.length > 10) return false;

        return true;
    }

    _shouldIgnoreNormalizedEvent(normalized) {
        if (!normalized || typeof normalized !== "object") return true;

        const type = String(normalized.type || "").toLowerCase();
        const isClickLike = type.includes("click");

        if (!isClickLike) return false;
        if (
            ["card_clicked", "button_clicked", "link_clicked", "menu_clicked", "tab_changed"].includes(type)
        ) {
            return false;
        }

        const uiType =
            normalized.uiType ||
            normalized.ui_type ||
            normalized.meta?.uiType ||
            normalized.meta?.ui_type ||
            null;

        const targetElement =
            normalized.targetElement ||
            normalized.target_element ||
            normalized.identifier ||
            normalized.meta?.targetElement ||
            normalized.meta?.target_element ||
            null;

        const field =
            normalized.field ||
            normalized.field_name ||
            normalized.meta?.field ||
            normalized.meta?.field_name ||
            null;

        const label =
            normalized.label ||
            normalized.meta?.label ||
            normalized.text ||
            normalized.name ||
            null;

        const uniqueKey =
            normalized.uniqueKey ||
            normalized.unique_key ||
            normalized.meta?.uniqueKey ||
            normalized.meta?.unique_key ||
            null;

        const role =
            normalized.role ||
            normalized.meta?.role ||
            null;

        const href =
            normalized.href ||
            normalized.meta?.href ||
            null;

        const hasUsefulHref = !!href;
        const hasSemanticField = this._isSemanticFieldRef(field);
        const hasUsefulTarget = !!targetElement && !this._isGenericDomRef(targetElement);
        const hasUsefulLabel = this._isMeaningfulLabel(label);

        const normalizedLabel = String(label || "").trim().toLowerCase();

        const isCommonActionButton =
            [
                "new",
                "create",
                "save",
                "discard",
                "edit",
                "cancel",
                "confirm",
                "apply",
                "add",
                "remove",
                "delete",
                "upload",
                "import",
                "export",
                "automate",
                "order",
                "snooze",
            ].includes(normalizedLabel);

        const isButtonLike =
            uiType === "Button" ||
            String(role || "").toLowerCase() === "button" ||
            (targetElement && String(targetElement).toLowerCase().startsWith("button."));

        if (hasUsefulHref) return false;
        if (hasSemanticField) return false;
        if (hasUsefulTarget) return false;

        if (isButtonLike && (hasUsefulLabel || isCommonActionButton)) {
            return false;
        }

        if (
            role &&
            ["menuitem", "tab", "checkbox", "link"].includes(String(role).toLowerCase()) &&
            hasUsefulLabel
        ) {
            return false;
        }

        if (uniqueKey) {
            const uk = String(uniqueKey);
            if (
                /^Other-\d+$/.test(uk) ||
                /^Button-\d+$/.test(uk) ||
                /^Link-\d+$/.test(uk) ||
                /^Input-\d+$/.test(uk) ||
                /^List-\d+$/.test(uk)
            ) {
                return true;
            }
        }

        if (label && !hasUsefulLabel && !hasSemanticField && !hasUsefulTarget && !hasUsefulHref) {
            return true;
        }

        return true;
    }

    get previewTimeAgo() {
        this.state.previewTick;
        return formatTimeAgo(this.state.previewTimestamp);
    }

    translate(text) {
        return _t(text);
    }

    get openTutorLabel() {
        return _t("Open Odoo Tutor");
    }

    get openTutorTitle() {
        return this.launcherHasAttention
            ? _t("Open Odoo Tutor - new guidance available")
            : _t("Open Odoo Tutor");
    }

    get isPreviewFresh() {
        this.state.previewTick;
        if (!this.state.previewTimestamp) {
            return false;
        }
        const ts = new Date(this.state.previewTimestamp).getTime();
        return Number.isFinite(ts) && Date.now() - ts < 2 * 60 * 1000;
    }

    get launcherHasAttention() {
        return (
            this.launcherExerciseCtaVisible ||
            (
                !!this.state.previewMessage &&
                !this.state.chatOpen &&
                !this.state.dragging &&
                !this._previewDismissed &&
                this.isPreviewFresh
            )
        );
    }

    get launcherExerciseCtaVisible() {
        return (
            !!this.state.exerciseCtaVisible &&
            !!this.state.exerciseCtaId &&
            !this.state.chatOpen &&
            !this.state.dragging &&
            !!this.state.previewMessage
        );
    }

    get exerciseCtaBusy() {
        return this.state.exerciseCtaStatus === "sending";
    }

    closePreview() {
        if (this.state.exerciseCtaVisible) {
            return;
        }
        this._previewDismissed = true;
        this.state.previewVisible = false;
        this._suppressNextClick = false;
        this._syncPreviewState?.();
    }

    _dispatchExerciseChoice(action) {
        if (!this.state.exerciseCtaId || this.exerciseCtaBusy) return;

        this.state.exerciseCtaStatus = "sending";
        window.dispatchEvent(new CustomEvent(EXERCISE_CHOICE_EVENT, {
            detail: {
                exerciseId: this.state.exerciseCtaId,
                action,
                answer: action === "start" ? "Yes" : "No",
            },
        }));
    }

    onExerciseCtaStart(ev) {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        this._dispatchExerciseChoice("start");
    }

    onExerciseCtaCancel(ev) {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        this._dispatchExerciseChoice("cancel");
    }

    toggleChat() {
        const el = document.getElementById("offcanvasAiSidebar");
        if (!el) return;

        let opened = false;

        try {
            const BsOffcanvas =
                window.bootstrap?.Offcanvas ||
                globalThis.bootstrap?.Offcanvas;

            if (BsOffcanvas) {
                const inst = BsOffcanvas.getOrCreateInstance(el);
                inst.show();
                opened = true;
            }
        } catch (e) {
            console.warn("[AiFloatingButton] bootstrap offcanvas open failed:", e);
        }

        if (!opened) {
            el.classList.add("show");
            el.setAttribute("aria-modal", "true");
            el.removeAttribute("aria-hidden");
            el.style.visibility = "visible";

            let backdrop = document.querySelector(".offcanvas-backdrop");
            if (!backdrop) {
                backdrop = document.createElement("div");
                backdrop.className = "offcanvas-backdrop fade show";
                document.body.appendChild(backdrop);

                backdrop.addEventListener("click", () => {
                    try {
                        el.classList.remove("show");
                        el.setAttribute("aria-hidden", "true");
                        el.removeAttribute("aria-modal");
                        backdrop.remove();
                        document.body.classList.remove("offcanvas-open");
                        el.dispatchEvent(new CustomEvent("hidden.bs.offcanvas", { bubbles: true }));
                    } catch {}
                }, { once: true });
            } else {
                backdrop.classList.add("show");
            }

            document.body.classList.add("offcanvas-open");

            try {
                el.dispatchEvent(new CustomEvent("shown.bs.offcanvas", { bubbles: true }));
            } catch {}
        }

        this.state.previewVisible = false;
        this._syncPreviewState?.();

        this._focusChatInput();
    }

    _focusChatInput() {
        const tryFocus = () => {
            const root = document.getElementById("offcanvasAiSidebar") || document;

            const selectors = [
                '#chat-ui-container textarea',
                '#chat-ui-container input[type="text"]',
                '#chat-ui-container input:not([type])',
                '#chat-ui-container [contenteditable="true"]',
                '#chat-ui-container .nlux-comp-composer textarea',
                '#chat-ui-container .nlux-comp-composer input',
                '#chat-ui-container .nlux-comp-chatInput textarea',
                '#chat-ui-container .nlux-comp-chatInput input',
                '#chat-ui-container .nlux-comp-messageComposer textarea',
                '#chat-ui-container .nlux-comp-messageComposer input',
                '#chat-ui-container .nlux-comp-promptBox textarea',
                '#chat-ui-container .nlux-comp-promptBox input',
            ];

            let el = null;
            for (const selector of selectors) {
                el = root.querySelector?.(selector);
                if (el) break;
            }

            if (!el) {
                return false;
            }

            try {
                el.focus({ preventScroll: true });

                if (typeof el.value === "string" && typeof el.setSelectionRange === "function") {
                    const len = el.value.length;
                    el.setSelectionRange(len, len);
                }

                return document.activeElement === el;
            } catch {
                return false;
            }
        };

        if (tryFocus()) return;

        clearTimeout(this._focusChatTimer1);
        clearTimeout(this._focusChatTimer2);
        clearTimeout(this._focusChatTimer3);
        clearTimeout(this._focusChatTimer4);

        this._focusChatTimer1 = setTimeout(() => tryFocus(), 0);
        this._focusChatTimer2 = setTimeout(() => tryFocus(), 120);
        this._focusChatTimer3 = setTimeout(() => tryFocus(), 300);
        this._focusChatTimer4 = setTimeout(() => tryFocus(), 600);
    }

    _getContextSnapshot() {
        try {
            const ctx = this.contextService?.getContext?.() || {};
            const props = this.actionService.currentController?.props || {};

            if (this._isHomeMenu()) {
                return {
                    model: "ir.ui.menu",
                    viewType: "home_menu",
                    resId: null,
                };
            }

            const model = props.resModel || ctx.model || null;

            const viewType =
                props.viewType ||
                ctx.view ||
                (document.querySelector(".o_form_view, .o_form_renderer") ? "form" : null) ||
                (document.querySelector(".o_list_view, .o_list_renderer") ? "list" : null) ||
                (document.querySelector(".o_kanban_view, .o_kanban_renderer") ? "kanban" : null) ||
                (document.querySelector(".o_calendar_view") ? "calendar" : null) ||
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

    _getActionableTarget(el) {
        if (!el?.closest) return null;

        return el.closest(`
            button,
            [role="button"],
            [role="menuitem"],
            [role="tab"],
            a[href],
            .btn,
            .dropdown-item,
            .o_form_button_create,
            .o_form_button_save,
            .o_form_button_cancel,
            .o_statusbar_button,
            .o-kanban-button
        `);
    }

    _getActionableLabel(el) {
        if (!el) return null;

        const text = cleanText(
            el.innerText ||
            el.textContent ||
            el.getAttribute?.("title") ||
            el.getAttribute?.("aria-label") ||
            ""
        );

        if (text) return text;

        const icon = el.querySelector?.("i[title], span[title]");
        if (icon?.getAttribute) {
            return cleanText(icon.getAttribute("title") || "");
        }

        return null;
    }

    _isClearlyActionableClick(rawTarget) {
        const actionable = this._getActionableTarget(rawTarget);
        if (!actionable) return false;

        const tag = (actionable.tagName || "").toLowerCase();
        const role = (actionable.getAttribute?.("role") || "").toLowerCase();
        const cls = (actionable.className || "").toString();

        if (tag === "button") return true;
        if (tag === "a") return true;
        if (["button", "menuitem", "tab"].includes(role)) return true;

        if (
            cls.includes("btn") ||
            cls.includes("dropdown-item") ||
            cls.includes("o_form_button_create") ||
            cls.includes("o_form_button_save") ||
            cls.includes("o_form_button_cancel") ||
            cls.includes("o_statusbar_button") ||
            cls.includes("o-kanban-button")
        ) {
            return true;
        }

        return false;
    }

    _patchNormalizedWithActionable(normalized, rawTarget) {
        const actionable = this._getActionableTarget(rawTarget);
        if (!actionable || !normalized) return normalized;
        if (["card_clicked", "record_opened"].includes(normalized.type)) return normalized;

        const label = this._getActionableLabel(actionable);
        const role = actionable.getAttribute?.("role") || null;
        const href = actionable.getAttribute?.("href") || null;
        const tag = (actionable.tagName || "").toLowerCase();

        let targetElement = null;
        const dataName = actionable.getAttribute?.("data-name");
        const name = actionable.getAttribute?.("name");
        const id = actionable.getAttribute?.("id");
        const title = actionable.getAttribute?.("title");

        if (dataName) targetElement = `${tag}.${dataName}`;
        else if (name) targetElement = `${tag}.${name}`;
        else if (id) targetElement = `${tag}#${id}`;
        else if (title) targetElement = `${tag}.${slugify(title)}`;
        else if (label) targetElement = `${tag}.${slugify(label)}`;

        return {
            ...normalized,
            type: normalized.type || "click",
            uiType: "Button",
            role: role || normalized.role || "button",
            label: label || normalized.label || null,
            href: href || normalized.href || null,
            targetElement: targetElement || normalized.targetElement || null,
            field:
                normalized.field && !String(normalized.field).startsWith("div.")
                    ? normalized.field
                    : null,
        };
    }

    _maybeRecordUiEvent(ev) {
        try {
            const isActive =
                window.getRecorderStatus?.() === "recording" ||
                window.__AI_TUTOR_RECORDER_ACTIVE;

            const normalized = {
                type:
                    ev.type === "input_final"
                        ? "field_changed"
                        : ev.type === "click" && ev.uiType === "Button"
                        ? "button_clicked"
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

            if (window.aiWs?.sendEvent) {
                window.aiWs.sendEvent(normalized);
            }
        } catch (err) {
            console.warn("[AI_UI] normalize error", err);
        }
    }

    onWillUnmount() {
        clearInterval(this._interval);

        try {
            AI_DOC.removeEventListener("click", this._onDocClick, true);
            AI_DOC.removeEventListener("input", this._onDocInput, true);
            AI_DOC.removeEventListener("change", this._onDocChange, true);
        } catch {}

        if (this._onPreviewMessage) {
            this.aiWs?.unsubscribe?.(this._onPreviewMessage);
            this._onPreviewMessage = null;
        }

        if (this._bindOffcanvasEvents) {
            this._bindOffcanvasEvents = null;
        }

        if (this._previewTimer) {
            clearInterval(this._previewTimer);
            this._previewTimer = null;
        }

        if (this._offcanvasBindTimer) {
            clearInterval(this._offcanvasBindTimer);
            this._offcanvasBindTimer = null;
        }

        if (this._onPreviewReset) {
            window.removeEventListener("ai:preview_reset", this._onPreviewReset);
            this._onPreviewReset = null;
        }

        if (this._onExerciseCtaUpdate) {
            window.removeEventListener(EXERCISE_CTA_EVENT, this._onExerciseCtaUpdate);
            this._onExerciseCtaUpdate = null;
        }

        if (this._onSidebarClosed) {
            window.removeEventListener(SIDEBAR_CLOSED_EVENT, this._onSidebarClosed);
            this._onSidebarClosed = null;
        }

        if (this._onWindowResize) {
            window.removeEventListener("resize", this._onWindowResize);
            this._onWindowResize = null;
        }

        if (this._boundDragMove) {
            window.removeEventListener("mousemove", this._boundDragMove);
            window.removeEventListener("touchmove", this._boundDragMove);
        }
        if (this._boundDragEnd) {
            window.removeEventListener("mouseup", this._boundDragEnd);
            window.removeEventListener("touchend", this._boundDragEnd);
            window.removeEventListener("touchcancel", this._boundDragEnd);
        }

        document.body.classList.remove("ai-widget-dragging");

        const offcanvasEl = document.getElementById("offcanvasAiSidebar");
        if (offcanvasEl && this._onOffcanvasShown) {
            offcanvasEl.removeEventListener("shown.bs.offcanvas", this._onOffcanvasShown);
        }
        if (offcanvasEl && this._onOffcanvasHidden) {
            offcanvasEl.removeEventListener("hidden.bs.offcanvas", this._onOffcanvasHidden);
        }

        this._onOffcanvasShown = null;
        this._onOffcanvasHidden = null;

        this._onDocClick = null;
        this._onDocInput = null;
        this._onDocChange = null;
        clearTimeout(this._focusChatTimer1);
        clearTimeout(this._focusChatTimer2);
        clearTimeout(this._focusChatTimer3);
        clearTimeout(this._focusChatTimer4);
    }
}

registry.category("main_components").add(
    "AiFloatingButton",
    { Component: AiFloatingButton },
    { sequence: 100 }
);
