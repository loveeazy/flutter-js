// @ufjs/webgl — WebGL contexts for fjs canvas (spec 021, modularized 022).
//
// Importing this module registers 'webgl' and 'webgl2' into the runtime's
// context registry; an app that never imports it gets null + one warning on
// BOTH platforms (the registry's unregistered behavior, constitution I). The
// page-facing API is the DOM's: canvas.getContext('webgl'), every method and
// constant named as the browser names them.
//
//   web:   the browser's own context, handed straight through — the wrapper
//          already gives pages DOM semantics (dpr, resize, events).
//   app:   commands are encoded into op 11 (the runtime's op protocol) and
//          executed on the Dart side by flutter_angle (ANGLE → Metal /
//          Vulkan); see flutter/lib in this package.
//
// WebGL 2 shares the command stream: the ANGLE backend is GLES3, so the same
// 1.0-family commands execute unchanged. webgl2-only APIs (VAO, instancing)
// work on web's native context and warn-once on the app — the ⚠️ row in
// docs/canvas-compat.md. Pages should ask webgl2 first and fall back:
// `getContext('webgl2') ?? getContext('webgl')` — new Chromium builds no
// longer provide WebGL 1 at all.
import { registerContextType } from '@ufjs/runtime';

import {
  createWebgl2Context,
  createWebglContext,
} from './src/context';

let registered = false;

/** Idempotent registration. Importing the module already does this; calling
 * it again is harmless. */
export function registerWebgl(): void {
  if (registered) return;
  registered = true;
  registerContextType('webgl', createWebglContext);
  registerContextType('webgl2', createWebgl2Context);
}

registerWebgl();

export { GL, FjsWebGLObject } from './src/context';
export type {
  FjsWebGLRenderingContext,
  FjsWebGLRenderingContextWithConstants,
} from './src/context';
