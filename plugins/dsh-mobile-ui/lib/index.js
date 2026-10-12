/**
 * dsh-mobile-ui — Host half.
 *
 * The whole feature is browser-side (a phone-scoped style layer), so the Host
 * half only needs to exist for the bundle row to mount. Keep it empty.
 */

/** No Host-side services are required. */
export const inject = [];

/** Nothing to do on the Host: the Client half owns the phone layer. */
export function apply() {}
