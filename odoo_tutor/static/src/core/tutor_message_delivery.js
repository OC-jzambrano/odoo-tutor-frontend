/** @odoo-module **/

// Tutor pushes (drift check-ins, exercise responses, step hints, ...) must
// render in the order they were produced. If the sidebar is closed, a
// message pushed straight into nlux jumps ahead of anything still sitting
// in the pending queue and shows up out of order once the chat reopens, so
// every call site must queue instead of pushing directly in that case.
export function shouldQueueTutorMessage({ aiChat, isSidebarOpen }) {
  return !aiChat || !isSidebarOpen;
}
