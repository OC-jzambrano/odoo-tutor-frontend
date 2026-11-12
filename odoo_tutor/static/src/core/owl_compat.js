/** Lightweight bridges for the Owl 2 state/ref API used by this addon. */

import { proxy, signal } from "@odoo/owl";

export function useState(initialState) {
  return proxy(initialState);
}

export function useRef() {
  const ref = signal.ref();
  return {
    signal: ref,
    get el() {
      return ref();
    },
  };
}
