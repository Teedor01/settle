import { installNetLog } from '../../phase1/netlog';
import { DiagnosticsCollector } from './diagnostics';

/**
 * Imported SECOND by main.ts (after the App Check debug flag, before any Firebase module), so request logging is in place
 * before the Firebase SDK is evaluated. Reuses the Phase 1 logger unchanged. Same limits apply (see README section 7).
 */
export const net = installNetLog(window, { origin: location.origin });

/** Evidence for the browser test plan: console errors, uncaught errors and unhandled rejections from page load onward. */
export const diagnostics = new DiagnosticsCollector();
diagnostics.attach(window);
