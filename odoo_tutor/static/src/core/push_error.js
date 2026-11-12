export function isBrowserPushRegistrationError(error) {
    const name = String(error?.name || "");
    const message = String(error?.message || error || "");
    const text = `${name} ${message}`.toLowerCase();

    return (
        name === "AbortError" ||
        text.includes("push service") ||
        text.includes("serviceworkerregistration") ||
        text.includes("push registration") ||
        text.includes("registration failed")
    );
}
