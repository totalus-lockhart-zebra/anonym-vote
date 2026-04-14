/**
 * Compatibility re-export so existing verify-command imports keep working
 * after we consolidated all WASM access into `ring-sig.ts`.
 */

export { verify as verifyRingSig } from './ring-sig';
