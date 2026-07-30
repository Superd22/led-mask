/**
 * The one transport instance, shared by both UIs.
 *
 * It lives in its own module so the friendly UI and the dev harness talk to the same mask, the same
 * connection and the same log — importing the class twice would give two independent transports.
 */
import { MaskTransport } from './mask-transport.js';

export const mask = new MaskTransport();
