/* eslint-disable */
/** @odoo-module **/

import { registry } from "@web/core/registry";
import {
  buildKanbanMovedEvent,
  buildNotificationShownEvent,
  buildSearchChangedEvent,
  buildX2ManyRowEvent,
} from "./interaction_events";

const X2MANY_SELECTOR = ".o_field_one2many, .o_field_many2many";
const ROW_SELECTOR = ".o_data_row, .o_kanban_record";

export const interactionObserverService = {
  dependencies: ["ai_ws", "context_service"],

  start(_env, { ai_ws: aiWs, context_service: contextService }) {
    const rowCounts = new WeakMap();
    const seenNotifications = new WeakSet();
    let dragged = null;
    let searchTimer = null;

    const context = () => contextService?.getContext?.() || {};
    const send = (event) => {
      if (!event) return;
      aiWs?.sendEvent?.({
        type: "ui_event",
        event_name: event.name,
        event_data: event,
      });
    };

    const groupName = (element) =>
      element
        ?.closest?.(".o_kanban_group")
        ?.querySelector?.(".o_kanban_header_title, .o_column_title")
        ?.textContent?.trim() || null;

    document.addEventListener(
      "dragstart",
      (event) => {
        const record = event.target?.closest?.(".o_kanban_record");
        if (!record) return;
        dragged = {
          element: record,
          from_group: groupName(record),
          record_id:
            record.dataset?.resId ||
            record.dataset?.id ||
            record.getAttribute?.("data-res-id") ||
            null,
          record_name: record.textContent,
        };
      },
      true
    );

    document.addEventListener(
      "dragend",
      () => {
        const move = dragged;
        dragged = null;
        if (!move) return;
        setTimeout(() => {
          send(
            buildKanbanMovedEvent(
              { ...move, to_group: groupName(move.element) },
              context()
            )
          );
        }, 100);
      },
      true
    );

    const emitSearch = () => {
      searchTimer = null;
      const query = document.querySelector(".o_searchview_input")?.value || "";
      const filters = Array.from(
        document.querySelectorAll(".o_searchview_facet .o_facet_value")
      ).map((element) => element.textContent);
      send(buildSearchChangedEvent({ query, filters }, context()));
    };

    document.addEventListener(
      "input",
      (event) => {
        if (!event.target?.matches?.(".o_searchview_input")) return;
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(emitSearch, 250);
      },
      true
    );

    const observer = new MutationObserver((mutations) => {
      let searchChanged = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          const notifications = [
            ...(node.matches(".o_notification") ? [node] : []),
            ...node.querySelectorAll(".o_notification"),
          ];
          for (const notification of notifications) {
            if (seenNotifications.has(notification)) continue;
            seenNotifications.add(notification);
            const typeClass = [...notification.classList].find((item) =>
              /^(bg-|border-)?(success|danger|warning|info)$/.test(item)
            );
            send(
              buildNotificationShownEvent(
                {
                  type:
                    typeClass?.match(/(success|danger|warning|info)$/)?.[1] ||
                    notification.dataset?.type,
                  title: notification.querySelector(".o_notification_title")?.textContent,
                  message:
                    notification.querySelector(".o_notification_content")?.textContent ||
                    notification.textContent,
                },
                context()
              )
            );
          }
        }

        const target = mutation.target instanceof Element ? mutation.target : null;
        if (target?.closest?.(".o_searchview")) searchChanged = true;
      }

      document.querySelectorAll(X2MANY_SELECTOR).forEach((widget) => {
        const field =
          widget.getAttribute("name") ||
          widget.closest("[name]")?.getAttribute("name");
        const count = widget.querySelectorAll(ROW_SELECTOR).length;
        if (!rowCounts.has(widget)) {
          rowCounts.set(widget, count);
          return;
        }
        const previous = rowCounts.get(widget);
        if (previous !== count) {
          rowCounts.set(widget, count);
          send(
            buildX2ManyRowEvent(
              { field, before: previous, after: count },
              context()
            )
          );
        }
      });

      if (searchChanged) {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(emitSearch, 50);
      }
    });

    document.querySelectorAll(X2MANY_SELECTOR).forEach((widget) => {
      rowCounts.set(widget, widget.querySelectorAll(ROW_SELECTOR).length);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return {};
  },
};

registry
  .category("services")
  .add("interaction_observer", interactionObserverService);
