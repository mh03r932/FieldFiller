import { localise, message } from '@/lib/platform/i18n';

/**
 * Options page shell. Empty of settings by design — Phase 4 builds the
 * configuration UI, and building it before the engine exists would invert the
 * dependency (implementation plan, ordering principle 3).
 *
 * What it does establish now is the string-resolution pattern: every user-facing
 * string comes from the i18n catalog (NFR-018), so no component ever hard-codes
 * one and localisation in a later phase is a catalog change rather than a sweep
 * through the UI.
 */
document.title = message('extName');
localise(document);
