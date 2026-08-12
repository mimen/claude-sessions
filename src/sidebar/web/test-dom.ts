/**
 * Registers a DOM for the whole test run.
 *
 * It has to be a preload rather than a line at the top of the one file that needs it. Modules are
 * cached per process, and `react-dom` binds to whatever globals exist when it first loads — so a
 * server-rendering test that imports it first leaves the later mounted test with a React that can
 * never attach an event listener. The menu then simply does not open, with no error to explain it.
 *
 * Registering before any module loads is the only ordering that holds. Nothing outside the browser
 * bundle reads these globals, and the one place that checks (`focus-bridge`) asks for
 * `window.webkit`, which happy-dom does not provide and cmux does.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
// React only enables `act` when the environment claims to be a test one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
