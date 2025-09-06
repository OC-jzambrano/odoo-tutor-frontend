/* eslint-disable */
/** @odoo-module **/
import { Component, onMounted, onWillUnmount, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

    function parseMaybeJSON(v) {
        if (Array.isArray(v)) return v;
        if (v && typeof v === "object") return v;
        if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } }
        return v;
    }

    /*
     * Cómo usar TryChroma:
     * - En consola: setChromaTask({...})  → carga una tarea (acepta strings JSON)
     * - Luego:      validateChromaTask()  → valida por "search + conteo" y muestra checklist
     *
    */


    /*
     * Parsea parámetros tipo hash (#action=...&menu_id=...).
     * Si no se pasa `hash`, usa window.location.hash.
    */
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
    function findClosestData(el) {
        // Busca pistas de modelo / id en comunes de Odoo
        const row = el.closest("[data-res-id], [data-id]"); // list/kanban rows
        const view = el.closest("[data-res-model]");        // algunas vistas lo traen
        const any = el.closest("[data-model], [data-name]");
        const out = {};
        if (row) {
            const rid = row.getAttribute("data-res-id") || row.getAttribute("data-id");
            if (rid) out.targetResId = Number(rid);
        }
        if (view && view.getAttribute("data-res-model")) {
            out.targetModel = view.getAttribute("data-res-model");
        }
        if (any && any.getAttribute("data-model")) {
            out.targetModel = out.targetModel || any.getAttribute("data-model");
        }
        // campo editable
        if (el.name) out.targetField = el.name;
        else if (any && any.getAttribute("data-name")) out.targetField = any.getAttribute("data-name");
        return out;
    }

export class AiFloatingButton extends Component {
    static template = "ai_chat.AiFloatingButton";

    setup() {
        this.actionService = useService("action");
        this.contextService = useService("context_service");
        /* [ADD] Servicios usados para validar/avisar */
        this.orm = useService("orm");
        this.notification = useService("notification");

        this.state = useState({
            showButton: false,
            logs: [],
            task: null,
            ctx: {
                model: null, viewType: null, actionId: null, menuId: null, resId: null, route: null,
            },
        });

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
            "account.journal",
            "account.account",
            "account.payment",
            "account.move",
            "account.invoice",
            "purchase.order",
            "res.config.settings",
        ];

        // intervalo para mostrar datos
        this.intervalId = null;

        if (this.router?.bus) {
            this.router.bus.addEventListener("ROUTE_CHANGE", (ev) => {
                console.log("Ruta cambiada", ev.detail.to);
            });
        }

        if (this.actionService?.bus) {
            this.actionService.bus.addEventListener("ACTION_EXECUTED", (ev) => {
                console.log("Acción ejecutada", ev.detail.action);
            });
        }
        // Detectar clicks en cualquier parte de la interfaz
        document.addEventListener(
          "click",
          (ev) => {
            if (ev.target && ev.target.tagName) {
              const base = this._getContextSnapshot();

              const link = ev.target.closest('a, [role="menuitem"], .o_app, .o_menuitem, .dropdown-item');
              // datos del link
              let href = null, actionId = null, menuId = null, menuXmlid = null;
              if (link) {
                href = link.getAttribute("href") || null;

                // 1) dataset directo
                const ds = link.dataset || {};
                if (ds.actionId) actionId = Number(ds.actionId);
                if (ds.menuId)   menuId   = Number(ds.menuId);
                menuXmlid = ds.menuXmlid || ds.menuXmlId || ds.xmlid || null;

                // 2) hash del href (#action=...&menu_id=...)
                if ((!actionId || !menuId) && href && href.includes("#")) {
                  const hashStr = href.split("#")[1];
                  const h = parseHashParams(hashStr);
                  if (!actionId && h.action) actionId = Number(h.action);
                  if (!menuId   && h.menu_id) menuId  = Number(h.menu_id);
                }

                // 3) query del href (?action=...&menu_id=...)
                if ((!actionId || !menuId) && href && href.includes("?")) {
                  const q = parseQueryParams(href);
                  if (!actionId && q.action) actionId = Number(q.action);
                  if (!menuId   && q.menu_id) menuId  = Number(q.menu_id);
                }
              }

              // info de DOM  (helper actual)
              const tctx = findClosestData(ev.target);

              this.addLog("click", {
                tag: ev.target.tagName,
                text: ev.target.innerText?.trim()?.slice(0, 50) || "",
                className: ev.target.className,
                href, actionId, menuId, menuXmlid,   // 👈 nuevo
                ...base,
                ...tctx,
              });

              setTimeout(() => {
                const after = this._getContextSnapshot();
                if (after.actionId || after.menuId) {
                  this.addLog("route_after", after);
                }
              }, 0);
            }
          },
          true
        );


        // Detectar cambios en inputs y textareas
        document.addEventListener(
            "input",
            (ev) => {
                if (["INPUT", "TEXTAREA"].includes(ev.target.tagName)) {
                    const base = this._getContextSnapshot();
                    const tctx = findClosestData(ev.target);
                    this.addLog("input", {
                        name: ev.target.name,
                        value: ev.target.value?.slice(0, 50) || "",
                        ...base,
                        ...tctx,
                    });
                }
            },
            true
        );

        // Iniciar intervalo para mostrar logs cada 10s
        onMounted(() => {
            this.intervalId = setInterval(() => {
                if (this.state.logs.length) {
                    const c = this.state.ctx || {};
                    console.log("User activity logs:", this.state.logs);
                    console.log(
                        `[ctx] model=${c.model || "-"} view=${c.viewType || "-"} id=${c.resId || "-"} action=${c.actionId || "-"} menu=${c.menuId || "-"}`
                    );
                }
            }, 10000);
        });

        this._interval = setInterval(() => {
            let currentModel = null;
            let showButton = false;
            const currentAction = this.actionService.currentController?.props;

            if (currentAction) {
                currentModel = currentAction.resModel;
                if (this.modules.includes(currentModel)) {
                    showButton = true;
                }
            }
            this.state.showButton = showButton;

            // Variables utiles para saber si esta creando una orden de venta, pero
            // se debe mejorar para que funcione con cualquier modelo
            const currentPath2 = window.location.pathname;
            const isCreatingSaleOrder = currentPath2 === "/odoo/sales/new";

            if (isCreatingSaleOrder) {
                this.contextService.setContext(currentModel, "form", "create");
            } else if (currentModel) {
                this.contextService.setContext(currentModel, "form", "list");
            }
            this.state.ctx = this._getContextSnapshot();
        }, 500);

        // Limpiar intervalo al desmontar componente
        onWillUnmount(() => {
            if (this.intervalId) {
                clearInterval(this.intervalId);
            }
        });

        // Carga la tarea (pégala desde consola): setChromaTask({...})
        window.setChromaTask = (payload) => {
            try {
                const raw = typeof payload === "string" ? JSON.parse(payload) : payload;
                raw.instructions = parseMaybeJSON(raw.instructions);
                raw.hints = parseMaybeJSON(raw.hints);
                raw.success_criteria = parseMaybeJSON(raw.success_criteria);
                raw.validation_steps = parseMaybeJSON(raw.validation_steps);
                this.state.task = raw;
                this.notification.add(
                    `Tarea cargada: ${raw.goal || "(sin título)"} (pasos: ${Array.isArray(raw.validation_steps) ? raw.validation_steps.length : "?"})`,
                    { type: "success" }
                );
                console.info("Instrucciones:", raw.instructions);
                console.info("Validación:", raw.validation_steps);
            } catch (e) {
                console.error(e);
                this.notification.add("JSON inválido al cargar la tarea", { type: "danger" });
            }
        };

        // Valida la tarea por "search + conteo"
        window.validateChromaTask = async () => {
            try {
                const task = this.state.task;
                if (!task) throw new Error("No hay tarea cargada. Usa setChromaTask({...}).");

                const steps = parseMaybeJSON(task.validation_steps);
                if (!Array.isArray(steps)) throw new Error("validation_steps no es un array ni JSON válido.");

                const results = [];
                for (const s of steps) {
                    if (s.type !== "search") continue;

                    // 1) Buscar ids por dominio
                    let ids = [];
                    try {
                        ids = await this.orm.search(s.model, s.domain || []);
                    } catch (e) {
                        results.push({
                            id: s.id || "(sin id)",
                            ok: false,
                            details: `Error en search(${s.model}): ${e.message}`,
                        });
                        continue;
                    }

                    // 2) Regla de conteo genérica
                    const min = typeof s.min_count === "number" ? s.min_count : 1;
                    const max = typeof s.max_count === "number" ? s.max_count : null;
                    let ok = ids.length >= min && (max == null || ids.length <= max);

                    // 3) Detalle si falla (opcional: leer campos)
                    let details = `Coincidencias: ${ids.length} (min=${min}${max != null ? `, max=${max}` : ""})`;
                    if (!ok) {
                        if (!ids.length) {
                            details += ` | Dominio: ${JSON.stringify(s.domain || [])}`;
                        } else if (s.read_fields) {
                            try {
                                const recs = await this.orm.searchRead(
                                    s.model,
                                    [["id", "in", ids]],
                                    s.read_fields,
                                    { limit: 5 }
                                );
                                details += ` | Ejemplos: ${JSON.stringify(recs)}`;
                            } catch (e) {
                                details += ` | (no pude leer campos: ${e.message})`;
                            }
                        }
                    }

                    results.push({ id: s.id || "(sin id)", ok, details });
                }

                console.table(results);
                const allOk = results.every((r) => r.ok);
                this.notification.add(allOk ? "✅ Validación OK" : "❌ Faltan pasos — revisa la consola", {
                    type: allOk ? "success" : "warning",
                });
                this._renderChecklist(results); // pequeño checklist flotante
                return results;
            } catch (e) {
                console.error(e);
                this.notification.add(e.message || "Error validando la tarea", { type: "danger" });
            }
        };

        // Mostrar/ocultar checklist desde consola si quieres
        window.toggleChromaChecklist = () => {
            const el = document.getElementById("ai-chroma-checklist");
            if (el) el.style.display = el.style.display === "none" ? "block" : "none";
        };
    }


        _getContextSnapshot() {
            try {
                const props = this.actionService?.currentController?.props || {};
                const hash  = parseHashParams();
                const query = parseQueryParams(); // 👈 nuevo

                const getNum = (x) => (x != null && x !== "" && !Number.isNaN(Number(x)) ? Number(x) : null);

                return {
                    model:   props.resModel || hash.model || query.model || null,
                    viewType:props.viewType || hash.view_type || query.view_type || guessViewType(),
                    actionId:getNum(props.actionId) || getNum(hash.action) || getNum(query.action),
                    menuId:  getNum(hash.menu_id) || getNum(query.menu_id),
                    resId:   getNum(props.resId) || getNum(hash.id) || getNum(query.id),
                    route:   window.location.href,
                };
            } catch {
                return { model:null, viewType:null, actionId:null, menuId:null, resId:null, route:window.location.href };
            }
        }


    //user_activity_tracker test
    addLog(type, data) {
        if (this.state.logs.length > 1000) this.state.logs.splice(0, this.state.logs.length - 1000);
        this.state.logs.push({
            type,
            ...data,
            timestamp: new Date().toISOString(),
        });
    }

    /* [ADD] Checklist flotante muy simple para ver qué falta (compacto) */
    _renderChecklist(results) {
        try {
            const id = "ai-chroma-checklist";
            let el = document.getElementById(id);
            if (!el) {
                el = document.createElement("div");
                el.id = id;
                el.style.cssText =
                    "position:fixed;right:16px;bottom:88px;max-width:420px;z-index:99999;background:#111827;color:#f9fafb;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25);overflow:hidden;font-family:Inter,system-ui,Segoe UI,Roboto,Arial;";
                const header = document.createElement("div");
                header.style.cssText =
                    "display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#1f2937;border-bottom:1px solid #374151;font-weight:600;";
                header.innerHTML =
                    'Checklist <button id="ai-chroma-close" style="background:transparent;border:none;color:#e5e7eb;font-size:16px;cursor:pointer">✕</button>';
                const body = document.createElement("div");
                body.id = "ai-chroma-body";
                body.style.cssText = "padding:8px 10px;max-height:50vh;overflow:auto;";
                el.appendChild(header);
                el.appendChild(body);
                document.body.appendChild(el);
                document.getElementById("ai-chroma-close").onclick = () => (el.style.display = "none");
            }
            const body = document.getElementById("ai-chroma-body");
            body.innerHTML = "";
            results.forEach((r) => {
                const row = document.createElement("div");
                row.style.cssText =
                    "display:flex;gap:8px;align-items:flex-start;padding:6px;border-bottom:1px dashed #374151;";
                const icon = r.ok ? "✅" : "❌";
                row.innerHTML = `<div style="min-width:22px">${icon}</div>
                    <div>
                      <div style="font-weight:600">${r.id}</div>
                      <div style="font-size:12px;color:#d1d5db;white-space:pre-wrap">${r.details || "-"}</div>
                    </div>`;
                body.appendChild(row);
            });
            el.style.display = "block";
        } catch (e) {
            console.warn("No se pudo renderizar checklist:", e);
        }
    }

    willUnmount() {
        clearInterval(this._interval);
    }
}

registry.category("main_components").add(
    "AiFloatingButton",
    {
        Component: AiFloatingButton,
    },
    { sequence: 100 }
);
