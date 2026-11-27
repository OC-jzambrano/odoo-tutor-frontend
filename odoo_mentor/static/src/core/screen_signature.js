/* eslint-disable */
/** @odoo-module **/

function cleanText(value, maxLen = 240) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/\s+/g, " ").trim().slice(0, maxLen);
}

export function cleanXmlId(value) {
    const clean = cleanText(value, 240);
    if (!clean || /^\d+$/.test(clean)) {
        return null;
    }
    return clean;
}

export function extractActionXmlId(action) {
    if (!action || typeof action !== "object") return null;
    return cleanXmlId(action.xml_id ?? action.xmlid);
}

function parseMenuIdFromHash(hash = "") {
    try {
        const raw = String(hash || "").replace(/^#/, "");
        if (!raw) return null;
        const params = new URLSearchParams(raw);
        const menuId = params.get("menu_id");
        if (!menuId) return null;
        return /^\d+$/.test(menuId) ? Number(menuId) : menuId;
    } catch {
        return null;
    }
}

export function resolveMenuXmlId({
    menuService = null,
    action = null,
    hash = null,
    router = null,
} = {}) {
    if (!menuService || typeof menuService !== "object") return null;

    const explicitMenuId =
        action?.context?.menu_id ??
        router?.current?.menu_id ??
        parseMenuIdFromHash(
            hash !== null && hash !== undefined
                ? hash
                : typeof window !== "undefined"
                  ? window.location.hash
                  : ""
        );

    if (explicitMenuId !== null && explicitMenuId !== undefined && explicitMenuId !== "") {
        try {
            const numericId = /^\d+$/.test(String(explicitMenuId))
                ? Number(explicitMenuId)
                : explicitMenuId;
            const menu = menuService.getMenu?.(numericId);
            const xmlid = cleanXmlId(menu?.xmlid);
            if (xmlid) return xmlid;
        } catch {}
    }

    const actionId = action?.id;
    if (actionId !== null && actionId !== undefined && actionId !== "") {
        try {
            const allMenus = menuService.getAll?.();
            if (Array.isArray(allMenus) && allMenus.length) {
                const currentAppId = menuService.getCurrentApp?.()?.id ?? null;
                const actionIdStr = String(actionId);
                let bestMenu = null;
                let bestScore = -1;
                for (const menu of allMenus) {
                    if (!menu || menu.actionID === null || menu.actionID === undefined) continue;
                    if (String(menu.actionID) !== actionIdStr) continue;
                    const xmlid = cleanXmlId(menu.xmlid);
                    if (!xmlid) continue;
                    const isCurrentApp = currentAppId !== null && menu.appID === currentAppId;
                    const isLeaf =
                        menu.id !== menu.appID &&
                        !(Array.isArray(menu.children) && menu.children.length > 0);
                    const score = (isCurrentApp ? 2 : 0) + (isLeaf ? 1 : 0);
                    if (score > bestScore) {
                        bestScore = score;
                        bestMenu = xmlid;
                        if (score === 3) break;
                    }
                }
                if (bestMenu) return bestMenu;
            }
        } catch {}
    }

    return null;
}

export function normalizeTargetScreen(raw) {
    if (!raw || typeof raw !== "object") return null;
    const model = cleanText(raw.model || raw.resModel || raw.currentModel || "", 240) || null;
    const view_type = cleanText(raw.view_type || raw.viewType || raw.view || "", 60) || null;
    const action_xml_id = cleanXmlId(raw.action_xml_id ?? raw.actionXmlId);
    const menu_xml_id = cleanXmlId(raw.menu_xml_id ?? raw.menuXmlId);
    if (!model && !view_type && !action_xml_id && !menu_xml_id) {
        return null;
    }
    return {
        model,
        view_type,
        action_xml_id,
        menu_xml_id,
    };
}

export function extractScreenSignatureFromRuntime({
    controller = null,
    menuService = null,
    contextService = null,
    hash = null,
    router = null,
    fallbackViewType = null,
} = {}) {
    const props = controller?.props || {};
    const action = controller?.action || null;
    const root = controller?.model?.root || {};
    const ctx = (() => {
        try {
            return contextService?.getContext?.() || {};
        } catch {
            return {};
        }
    })();

    const model =
        cleanText(
            props.resModel || action?.res_model || root.resModel || ctx.model || "",
            240
        ) || null;
    const view_type =
        cleanText(
            props.viewType ||
                props.type ||
                controller?.view?.type ||
                action?.view_mode?.split?.(",")?.[0] ||
                ctx.view_type ||
                fallbackViewType ||
                "",
            60
        ) || null;
    const action_xml_id = extractActionXmlId(action);
    const menu_xml_id = resolveMenuXmlId({
        menuService,
        action,
        hash,
        router,
    });

    return {
        model,
        view_type,
        action_xml_id,
        menu_xml_id,
    };
}

export function screenSignaturesEqual(a, b) {
    const normA = normalizeTargetScreen(a);
    const normB = normalizeTargetScreen(b);
    if (!normA && !normB) return true;
    if (!normA || !normB) return false;
    return (
        normA.model === normB.model &&
        normA.view_type === normB.view_type &&
        normA.action_xml_id === normB.action_xml_id &&
        normA.menu_xml_id === normB.menu_xml_id
    );
}
