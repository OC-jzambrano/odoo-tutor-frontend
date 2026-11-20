/** @odoo-module **/

// Queue tutor messages whenever the chat is unmounted or closed to preserve order.
export function shouldQueueTutorMessage({ aiChat, isSidebarOpen }) {
  return !aiChat || !isSidebarOpen;
}
