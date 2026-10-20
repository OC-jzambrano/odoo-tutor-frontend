/** @odoo-module **/

// Queue tutor pushes while the sidebar is closed to preserve message order when it reopens.
export function shouldQueueTutorMessage({ aiChat, isSidebarOpen }) {
  return !aiChat || !isSidebarOpen;
}
