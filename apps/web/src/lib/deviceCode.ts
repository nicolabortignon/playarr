/** A TV's sign-in code as typed: any case, with spaces or dashes (the server's normalizeCode). */
export const normalizeDeviceCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
