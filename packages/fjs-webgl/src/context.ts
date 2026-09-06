// WebGLRenderingContext, implemented in JS on top of the command stream.
//
// The division of labour matches the 2d context: everything JS can hold —
// resource ids, the argument encoding, the error-free fast path — lives here;
// the host does the part JS cannot do at all, running the commands against a
// real GPU context (flutter_angle, in the fjs_webgl Dart package). The
// queries that the DOM's WebGL can answer synchronously — getAttribLocation,
// shader compile status, the info logs — cross back over invokeHost as
// scalars or JSON strings (v1 ABI, constitution II), which is why the spec
// only promises query semantics for resource/compile state, not for commands
// that have not been flushed yet.
//
// Unlike the 2d context there is NO state machine here: GL is already a
// state machine, deduplicating it client-side would need a faithful second
// copy of it, and a WebGL page redraws every frame anyway. Everything
// mutates the stream directly.
import {
  invokeHost,
  flushNow,
  getWriter,
  FjsCanvasImage,
  type CanvasContextTarget,
  type FjsCanvasOpWriter,
} from '@ufjs/runtime';
import { WebglChunkWriter } from './protocol';
import { warnWebglOnce } from './warn';

/** What the WebGL context needs from whatever owns the canvas: the core
 * surface's members, narrowed structurally (the core never names this
 * module, and this module never imports runtime internals). */
export interface WebglSurface {
  readonly nodeId: number;
  /** Current LOGICAL size; 0 before the host has laid the box out. */
  width(): number;
  height(): number;
  /** The ratio the host renders this canvas's backing store at. Real dpr on
   * web; on Flutter the host reports it in the size event. The 2d surface
   * hides dpr from the page — GL cannot, `viewport` is in pixels — so a
   * webgl context follows web semantics instead: bitmap size = logical ×
   * dpr, page derives viewport from gl.canvas.width. (spec 021 §3.2) */
  devicePixelRatio(): number;
  /** Frame plumbing: this module's chunks ride the canvas node's op frame
   * as op 11 (written through the core's op writer). */
  attachOpWriter(w: FjsCanvasOpWriter): void;
  /** The dirty signal the module's writer feeds — same flush cadence as 2d. */
  markDirty(): void;
}

/** An opaque GL resource: what `createBuffer()` & co. hand back. A page only
 * ever passes it back to the context that made it, so the id is the whole
 * story; the kind exists for error messages. */
export class FjsWebGLObject {
  constructor(
    readonly kind: string,
    /** 0 means "null object" — the DOM's `null` argument. */
    readonly id: number,
  ) {}

  toString(): string {
    return `[object ${this.kind}]`;
  }
}

type Resource = FjsWebGLObject | null;

function resourceId(res: Resource): number {
  // undefined/null → 0, which the host maps to "no object"
  return res instanceof FjsWebGLObject ? res.id : 0;
}

// -- constants (WebGL 1.0 spec values) -------------------------------------

export const GL = {
  /* ClearBufferMask */
  DEPTH_BUFFER_BIT: 0x00000100,
  STENCIL_BUFFER_BIT: 0x00000400,
  COLOR_BUFFER_BIT: 0x00004000,
  /* BeginMode */
  POINTS: 0,
  LINES: 1,
  LINE_LOOP: 2,
  LINE_STRIP: 3,
  TRIANGLES: 4,
  TRIANGLE_STRIP: 5,
  TRIANGLE_FAN: 6,
  /* BlendingFactorDest / BlendingFactorSrc */
  ZERO: 0,
  ONE: 1,
  SRC_COLOR: 0x0300,
  ONE_MINUS_SRC_COLOR: 0x0301,
  SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  DST_ALPHA: 0x0304,
  ONE_MINUS_DST_ALPHA: 0x0305,
  DST_COLOR: 0x0306,
  ONE_MINUS_DST_COLOR: 0x0307,
  SRC_ALPHA_SATURATE: 0x0308,
  CONSTANT_COLOR: 0x8001,
  ONE_MINUS_CONSTANT_COLOR: 0x8002,
  CONSTANT_ALPHA: 0x8003,
  ONE_MINUS_CONSTANT_ALPHA: 0x8004,
  BLEND_COLOR: 0x8005,
  FUNC_ADD: 0x8006,
  BLEND_EQUATION: 0x8009,
  BLEND_EQUATION_RGB: 0x8009,
  BLEND_EQUATION_ALPHA: 0x883d,
  FUNC_SUBTRACT: 0x800a,
  FUNC_REVERSE_SUBTRACT: 0x800b,
  BLEND_DST_RGB: 0x80c8,
  BLEND_SRC_RGB: 0x80c9,
  BLEND_DST_ALPHA: 0x80ca,
  BLEND_SRC_ALPHA: 0x80cb,
  /* Buffer objects */
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  ARRAY_BUFFER_BINDING: 0x8894,
  ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
  BUFFER_SIZE: 0x8764,
  BUFFER_USAGE: 0x8765,
  CURRENT_VERTEX_ATTRIB: 0x8626,
  /* BufferUsage */
  STREAM_DRAW: 0x88e0,
  STATIC_DRAW: 0x88e4,
  DYNAMIC_DRAW: 0x88e8,
  /* CullFaceMode */
  FRONT: 0x0404,
  BACK: 0x0405,
  FRONT_AND_BACK: 0x0408,
  CULL_FACE: 0x0b44,
  CULL_FACE_MODE: 0x0b45,
  FRONT_FACE: 0x0b46,
  /* EnableCap */
  BLEND: 0x0be2,
  DITHER: 0x0bd0,
  STENCIL_TEST: 0x0b90,
  DEPTH_TEST: 0x0b71,
  SCISSOR_TEST: 0x0c11,
  POLYGON_OFFSET_FILL: 0x8037,
  SAMPLE_ALPHA_TO_COVERAGE: 0x809e,
  SAMPLE_COVERAGE: 0x80a0,
  /* ErrorCode */
  NO_ERROR: 0,
  INVALID_ENUM: 0x0500,
  INVALID_VALUE: 0x0501,
  INVALID_OPERATION: 0x0502,
  INVALID_FRAMEBUFFER_OPERATION: 0x0506,
  OUT_OF_MEMORY: 0x0505,
  CONTEXT_LOST_WEBGL: 0x9242,
  /* FrontFaceDirection */
  CW: 0x0900,
  CCW: 0x0901,
  /* GetParameter */
  DEPTH_FUNC: 0x0b74,
  DEPTH_CLEAR_VALUE: 0x0b73,
  DEPTH_WRITEMASK: 0x0b72,
  DEPTH_RANGE: 0x0b70,
  STENCIL_CLEAR_VALUE: 0x0b91,
  STENCIL_FUNC: 0x0b92,
  STENCIL_VALUE_MASK: 0x0b93,
  STENCIL_FAIL: 0x0b94,
  STENCIL_PASS_DEPTH_FAIL: 0x0b95,
  STENCIL_PASS_DEPTH_PASS: 0x0b96,
  STENCIL_REF: 0x0b97,
  STENCIL_WRITEMASK: 0x0b98,
  STENCIL_BACK_FUNC: 0x8800,
  STENCIL_BACK_FAIL: 0x8801,
  STENCIL_BACK_PASS_DEPTH_FAIL: 0x8802,
  STENCIL_BACK_PASS_DEPTH_PASS: 0x8803,
  STENCIL_BACK_REF: 0x8ca3,
  STENCIL_BACK_VALUE_MASK: 0x8ca4,
  STENCIL_BACK_WRITEMASK: 0x8ca5,
  VIEWPORT: 0x0ba2,
  SCISSOR_BOX: 0x0c10,
  COLOR_CLEAR_VALUE: 0x0c22,
  COLOR_WRITEMASK: 0x0c23,
  LINE_WIDTH: 0x0b21,
  LINE_WIDTH_RANGE: 0x0b22,
  POLYGON_OFFSET_FACTOR: 0x8038,
  POLYGON_OFFSET_UNITS: 0x2a00,
  SAMPLE_COVERAGE_VALUE: 0x80aa,
  SAMPLE_COVERAGE_INVERT: 0x80ab,
  ACTIVE_TEXTURE: 0x84e0,
  ALIASED_LINE_WIDTH_RANGE: 0x846e,
  ALIASED_POINT_SIZE_RANGE: 0x846d,
  IMPLEMENTATION_COLOR_READ_FORMAT: 0x8b9b,
  IMPLEMENTATION_COLOR_READ_TYPE: 0x8b9a,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
  MAX_RENDERBUFFER_SIZE: 0x84e8,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_VARYING_VECTORS: 0x8dfc,
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
  MAX_VIEWPORT_DIMS: 0x0d3a,
  RED_BITS: 0x0d52,
  GREEN_BITS: 0x0d53,
  BLUE_BITS: 0x0d54,
  ALPHA_BITS: 0x0d55,
  DEPTH_BITS: 0x0d56,
  STENCIL_BITS: 0x0d57,
  SAMPLES: 0x80a9,
  SAMPLE_BUFFERS: 0x80a8,
  SUBPIXEL_BITS: 0x0d50,
  RENDERER: 0x1f01,
  VENDOR: 0x1f00,
  VERSION: 0x1f02,
  SHADING_LANGUAGE_VERSION: 0x8b8c,
  /* DepthFunction / StencilFunction */
  NEVER: 0x0200,
  LESS: 0x0201,
  EQUAL: 0x0202,
  LEQUAL: 0x0203,
  GREATER: 0x0204,
  NOTEQUAL: 0x0205,
  GEQUAL: 0x0206,
  ALWAYS: 0x0207,
  /* StencilOp */
  KEEP: 0x1e00,
  REPLACE: 0x1e01,
  INCR: 0x1e02,
  DECR: 0x1e03,
  INVERT: 0x150a,
  INCR_WRAP: 0x8507,
  DECR_WRAP: 0x8508,
  /* DataType / PixelType */
  UNSIGNED_BYTE: 0x1401,
  UNSIGNED_SHORT: 0x1403,
  UNSIGNED_INT: 0x1405,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  UNSIGNED_SHORT_4_4_4_4: 0x8033,
  UNSIGNED_SHORT_5_5_5_1: 0x8034,
  UNSIGNED_SHORT_5_6_5: 0x8363,
  /* Pixel formats / internal formats */
  DEPTH_COMPONENT: 0x1902,
  ALPHA: 0x1906,
  RGB: 0x1907,
  RGBA: 0x1908,
  LUMINANCE: 0x1909,
  LUMINANCE_ALPHA: 0x190a,
  RGB565: 0x8d62,
  RGBA4: 0x805f,
  RGB5_A1: 0x8057,
  RGBA8: 0x8058,
  DEPTH_COMPONENT16: 0x81a5,
  STENCIL_INDEX8: 0x8d48,
  DEPTH_STENCIL: 0x84f9,
  /* Texture */
  TEXTURE: 0x1702,
  TEXTURE_2D: 0x0de1,
  TEXTURE_CUBE_MAP: 0x8513,
  TEXTURE_BINDING_2D: 0x8069,
  TEXTURE_BINDING_CUBE_MAP: 0x8514,
  TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515,
  TEXTURE_CUBE_MAP_NEGATIVE_X: 0x8516,
  TEXTURE_CUBE_MAP_POSITIVE_Y: 0x8517,
  TEXTURE_CUBE_MAP_NEGATIVE_Y: 0x8518,
  TEXTURE_CUBE_MAP_POSITIVE_Z: 0x8519,
  TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851a,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  NEAREST: 0x2600,
  LINEAR: 0x2601,
  NEAREST_MIPMAP_NEAREST: 0x2700,
  LINEAR_MIPMAP_NEAREST: 0x2701,
  NEAREST_MIPMAP_LINEAR: 0x2702,
  LINEAR_MIPMAP_LINEAR: 0x2703,
  REPEAT: 0x2901,
  CLAMP_TO_EDGE: 0x812f,
  MIRRORED_REPEAT: 0x8370,
  GENERATE_MIPMAP_HINT: 0x8192,
  /* pixelStorei's WebGL-specific pnames */
  UNPACK_FLIP_Y_WEBGL: 0x9240,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  /* HintMode */
  DONT_CARE: 0x1100,
  FASTEST: 0x1101,
  NICEST: 0x1102,
  /* Framebuffer */
  FRAMEBUFFER: 0x8d40,
  RENDERBUFFER: 0x8d41,
  FRAMEBUFFER_BINDING: 0x8ca6,
  RENDERBUFFER_BINDING: 0x8ca7,
  COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_ATTACHMENT: 0x8d00,
  STENCIL_ATTACHMENT: 0x8d20,
  DEPTH_STENCIL_ATTACHMENT: 0x821a,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8cd6,
  FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8cd7,
  FRAMEBUFFER_INCOMPLETE_DIMENSIONS: 0x8cd9,
  FRAMEBUFFER_UNSUPPORTED: 0x8cdd,
  /* Vertex arrays */
  VERTEX_ATTRIB_ARRAY_ENABLED: 0x8622,
  VERTEX_ATTRIB_ARRAY_SIZE: 0x8623,
  VERTEX_ATTRIB_ARRAY_STRIDE: 0x8624,
  VERTEX_ATTRIB_ARRAY_TYPE: 0x8625,
  VERTEX_ATTRIB_ARRAY_NORMALIZED: 0x886a,
  VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: 0x889f,
  CURRENT_PROGRAM: 0x8b8d,
  /* Shaders */
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  VALIDATE_STATUS: 0x8b83,
  SHADER_TYPE: 0x8b4f,
  DELETE_STATUS: 0x8b80,
  ATTACHED_SHADERS: 0x8b85,
  ACTIVE_UNIFORMS: 0x8b86,
  ACTIVE_ATTRIBUTES: 0x8b89,
  /* Shader precision */
  HIGH_FLOAT: 0x8df2,
  MEDIUM_FLOAT: 0x8df1,
  LOW_FLOAT: 0x8df0,
  HIGH_INT: 0x8df5,
  MEDIUM_INT: 0x8df4,
  LOW_INT: 0x8df3,
} as const;

/** Accepts a TypedArray, a number[] or null for the fv / matrix / pixel
 * arguments. */
type NumericArg = number[] | Float32Array | Int32Array | Uint8Array | null;

function toArray(v: NumericArg): number[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return Array.from(v as ArrayLike<number>);
}

function toBytes(v: NumericArg): Uint8Array {
  if (!v) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) {
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  const out = new Uint8Array(v.length * 4);
  new Float32Array(out.buffer).set(v as number[]);
  return out;
}

/** Truncates a uniform array to a whole number of the call's vector size —
 * a ragged tail is INVALID_OPERATION in GL, and the decoder slices by the
 * command's implied arity, so sending the tail would corrupt the stream. */
function evenCount(v: number[], per: number, what: string): number[] {
  const usable = v.length - (v.length % per);
  if (usable !== v.length) {
    warnWebglOnce(
      `webgl-${what}`,
      `gl.${what}(): array length ${v.length} is not a multiple of ${per}; ` +
        'the tail was dropped (GL would raise INVALID_OPERATION).',
    );
  }
  return v.length === usable ? v : v.slice(0, usable);
}

export class FjsWebGLRenderingContext {
  /** Opaque id the host knows this context by (query dispatch key). */
  readonly ctxId: number;

  /** The DOM's `gl.canvas`. Assigned in the constructor; declared here so
   * pages get real types off it. */
  declare readonly canvas: { readonly width: number; readonly height: number };

  private readonly surface: WebglSurface;
  private readonly writer: WebglChunkWriter;
  private nextResourceId = 1;

  constructor(surface: WebglSurface, ctxId: number) {
    this.surface = surface;
    this.ctxId = ctxId;
    // The DOM's `gl.canvas`: the drawing buffer's size in DEVICE pixels,
    // unlike the 2d context's logical-pixel view (spec 021 §3.2).
    Object.defineProperty(this, 'canvas', {
      value: {
        get width(): number {
          return Math.round(surface.width() * surface.devicePixelRatio());
        },
        get height(): number {
          return Math.round(surface.height() * surface.devicePixelRatio());
        },
      },
      writable: false,
      enumerable: true,
      configurable: true,
    });
    // The module owns the command buffer; the core surface only carries it
    // through the frame as op 11.
    const writer = new WebglChunkWriter(() => surface.markDirty());
    this.writer = writer;
    surface.attachOpWriter({
      takeChunks: () => writer.takeChunks(),
      write: (nodeId: number, chunk: Uint8Array) => {
        getWriter().webgl(nodeId, chunk);
      },
    });
  }

  private nextId(): number {
    return this.nextResourceId++;
  }

  /** Synchronous query over the v1 ABI: scalars and strings only. */
  private q<T>(name: string, ...args: FjsHostValue[]): T {
    // Push this canvas's queued GL commands out NOW instead of at the
    // microtask flush: a page checks compile/link status in the same tick it
    // compiled (every WebGL page does), and the host can only answer from
    // state the stream has already delivered.
    flushNow();
    return invokeHost<T>(`fjs.webgl.${name}`, this.ctxId, ...args);
  }

  // -- resources -----------------------------------------------------------

  createBuffer(): FjsWebGLObject {
    const res = new FjsWebGLObject('WebGLBuffer', this.nextId());
    this.writer.createBuffer(res.id);
    return res;
  }

  deleteBuffer(res: Resource): void {
    const id = resourceId(res);
    if (id) this.writer.deleteBuffer(id);
  }

  createFramebuffer(): FjsWebGLObject {
    const res = new FjsWebGLObject('WebGLFramebuffer', this.nextId());
    this.writer.createFramebuffer(res.id);
    return res;
  }

  deleteFramebuffer(res: Resource): void {
    const id = resourceId(res);
    if (id) this.writer.deleteFramebuffer(id);
  }

  createProgram(): FjsWebGLObject {
    const res = new FjsWebGLObject('WebGLProgram', this.nextId());
    this.writer.createProgram(res.id);
    return res;
  }

  deleteProgram(res: Resource): void {
    const id = resourceId(res);
    if (id) this.writer.deleteProgram(id);
  }

  createRenderbuffer(): FjsWebGLObject {
    const res = new FjsWebGLObject('WebGLRenderbuffer', this.nextId());
    this.writer.createRenderbuffer(res.id);
    return res;
  }

  deleteRenderbuffer(res: Resource): void {
    const id = resourceId(res);
    if (id) this.writer.deleteRenderbuffer(id);
  }

  createTexture(): FjsWebGLObject {
    const res = new FjsWebGLObject('WebGLTexture', this.nextId());
    this.writer.createTexture(res.id);
    return res;
  }

  deleteTexture(res: Resource): void {
    const id = resourceId(res);
    if (id) this.writer.deleteTexture(id);
  }

  createShader(type: number): FjsWebGLObject | null {
    if (type !== GL.VERTEX_SHADER && type !== GL.FRAGMENT_SHADER) {
      warnWebglOnce(
        'webgl-shader-type',
        'gl.createShader(): type must be VERTEX_SHADER or FRAGMENT_SHADER.',
      );
      return null;
    }
    const res = new FjsWebGLObject(
      type === GL.VERTEX_SHADER ? 'WebGLVertexShader' : 'WebGLFragmentShader',
      this.nextId(),
    );
    this.writer.createShader(res.id, type);
    return res;
  }

  deleteShader(res: Resource): void {
    const id = resourceId(res);
    if (id) this.writer.deleteShader(id);
  }

  // -- binding & state -----------------------------------------------------

  activeTexture(unit: number): void {
    this.writer.activeTexture(unit);
  }

  bindBuffer(target: number, res: Resource): void {
    this.writer.bindBuffer(target, resourceId(res));
  }

  bindFramebuffer(target: number, res: Resource): void {
    this.writer.bindFramebuffer(target, resourceId(res));
  }

  bindRenderbuffer(target: number, res: Resource): void {
    this.writer.bindRenderbuffer(target, resourceId(res));
  }

  bindTexture(target: number, res: Resource): void {
    this.writer.bindTexture(target, resourceId(res));
  }

  blendColor(r: number, g: number, b: number, a: number): void {
    this.writer.blendColor(r, g, b, a);
  }

  blendEquation(mode: number): void {
    this.writer.blendEquation(mode);
  }

  blendEquationSeparate(modeRgb: number, modeAlpha: number): void {
    this.writer.blendEquationSeparate(modeRgb, modeAlpha);
  }

  blendFunc(sfactor: number, dfactor: number): void {
    this.writer.blendFunc(sfactor, dfactor);
  }

  blendFuncSeparate(
    srcRgb: number,
    dstRgb: number,
    srcAlpha: number,
    dstAlpha: number,
  ): void {
    this.writer.blendFuncSeparate(srcRgb, dstRgb, srcAlpha, dstAlpha);
  }

  clearColor(r: number, g: number, b: number, a: number): void {
    this.writer.clearColor(r, g, b, a);
  }

  clearDepth(depth: number): void {
    this.writer.clearDepth(depth);
  }

  clearStencil(s: number): void {
    this.writer.clearStencil(s);
  }

  colorMask(r: boolean, g: boolean, b: boolean, a: boolean): void {
    this.writer.colorMask(r, g, b, a);
  }

  cullFace(mode: number): void {
    this.writer.cullFace(mode);
  }

  depthFunc(func: number): void {
    this.writer.depthFunc(func);
  }

  depthMask(flag: boolean): void {
    this.writer.depthMask(flag);
  }

  depthRange(zNear: number, zFar: number): void {
    this.writer.depthRange(zNear, zFar);
  }

  disable(cap: number): void {
    this.writer.disable(cap);
  }

  enable(cap: number): void {
    this.writer.enable(cap);
  }

  frontFace(mode: number): void {
    this.writer.frontFace(mode);
  }

  hint(target: number, mode: number): void {
    this.writer.hint(target, mode);
  }

  lineWidth(width: number): void {
    this.writer.lineWidth(width);
  }

  pixelStorei(pname: number, param: number): void {
    this.writer.pixelStorei(pname, param);
  }

  polygonOffset(factor: number, units: number): void {
    this.writer.polygonOffset(factor, units);
  }

  sampleCoverage(value: number, invert: boolean): void {
    this.writer.sampleCoverage(value, invert);
  }

  scissor(x: number, y: number, width: number, height: number): void {
    this.writer.scissor(x, y, width, height);
  }

  stencilFunc(func: number, ref: number, mask: number): void {
    this.writer.stencilFunc(func, ref, mask);
  }

  stencilFuncSeparate(
    face: number,
    func: number,
    ref: number,
    mask: number,
  ): void {
    this.writer.stencilFuncSeparate(face, func, ref, mask);
  }

  stencilMask(mask: number): void {
    this.writer.stencilMask(mask);
  }

  stencilMaskSeparate(face: number, mask: number): void {
    this.writer.stencilMaskSeparate(face, mask);
  }

  stencilOp(fail: number, zfail: number, zpass: number): void {
    this.writer.stencilOp(fail, zfail, zpass);
  }

  stencilOpSeparate(
    face: number,
    fail: number,
    zfail: number,
    zpass: number,
  ): void {
    this.writer.stencilOpSeparate(face, fail, zfail, zpass);
  }

  viewport(x: number, y: number, width: number, height: number): void {
    this.writer.viewport(x, y, width, height);
  }

  // -- data upload ---------------------------------------------------------

  bufferData(
    target: number,
    data: NumericArg | number,
    usage?: number,
  ): void {
    if (typeof data === 'number') {
      this.writer.bufferDataSize(target, data, usage ?? GL.STATIC_DRAW);
      return;
    }
    this.writer.bufferData(target, toBytes(data), usage ?? GL.STATIC_DRAW);
  }

  bufferSubData(target: number, offset: number, data: NumericArg): void {
    this.writer.bufferSubData(target, offset, toBytes(data));
  }

  /** The DOM's 6-arg source form and 9-arg pixel form, told apart by arity.
   * The only source this runtime supports is `FjsCanvasImage` (handle across
   * the bridge, pixels stay on the host) — an HTMLImageElement cannot exist
   * here. */
  texImage2D(...args: unknown[]): void {
    if (args.length === 6) {
      const [target, level, internalformat, format, type, source] = args as [
        number,
        number,
        number,
        number,
        number,
        unknown,
      ];
      if (source instanceof FjsCanvasImage) {
        this.writer.texImage2DSource(
          target,
          level,
          internalformat,
          format,
          type,
          source.handle,
        );
        return;
      }
      warnWebglOnce(
        'webgl-tex-source',
        'gl.texImage2D(): the only supported source is the image object ' +
          'returned by loadImage()/FjsCanvasImage.',
      );
      return;
    }
    const [target, level, internalformat, width, height, border, format, type, pixels] =
      args as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        NumericArg,
      ];
    this.writer.texImage2D(
      target,
      level,
      internalformat,
      width,
      height,
      border,
      format,
      type,
      toBytes(pixels),
    );
  }

  texSubImage2D(...args: unknown[]): void {
    if (args.length === 6) {
      warnWebglOnce(
        'webgl-tex-sub-source',
        'gl.texSubImage2D(): source upload is not supported; pass pixels.',
      );
      return;
    }
    const [target, level, xoffset, yoffset, width, height, format, type, pixels] =
      args as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        NumericArg,
      ];
    this.writer.texSubImage2D(
      target,
      level,
      xoffset,
      yoffset,
      width,
      height,
      format,
      type,
      toBytes(pixels),
    );
  }

  texParameterf(target: number, pname: number, param: number): void {
    this.writer.texParameterf(target, pname, param);
  }

  texParameteri(target: number, pname: number, param: number): void {
    this.writer.texParameteri(target, pname, param);
  }

  generateMipmap(target: number): void {
    this.writer.generateMipmap(target);
  }

  // -- program -------------------------------------------------------------

  shaderSource(shader: Resource, source: string): void {
    const id = resourceId(shader);
    if (!id) return;
    this.writer.shaderSource(id, this.writer.str(source));
  }

  compileShader(shader: Resource): void {
    const id = resourceId(shader);
    if (id) this.writer.compileShader(id);
  }

  attachShader(program: Resource, shader: Resource): void {
    const p = resourceId(program);
    const s = resourceId(shader);
    if (p && s) this.writer.attachShader(p, s);
  }

  detachShader(program: Resource, shader: Resource): void {
    const p = resourceId(program);
    const s = resourceId(shader);
    if (p && s) this.writer.detachShader(p, s);
  }

  linkProgram(program: Resource): void {
    const id = resourceId(program);
    if (id) this.writer.linkProgram(id);
  }

  useProgram(program: Resource): void {
    this.writer.useProgram(resourceId(program));
  }

  validateProgram(program: Resource): void {
    const id = resourceId(program);
    if (id) this.writer.validateProgram(id);
  }

  bindAttribLocation(program: Resource, index: number, name: string): void {
    const id = resourceId(program);
    if (id) this.writer.bindAttribLocation(id, index, this.writer.str(name));
  }

  // -- vertex --------------------------------------------------------------

  enableVertexAttribArray(index: number): void {
    this.writer.enableVertexAttribArray(index);
  }

  disableVertexAttribArray(index: number): void {
    this.writer.disableVertexAttribArray(index);
  }

  vertexAttribPointer(
    index: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number,
  ): void {
    this.writer.vertexAttribPointer(index, size, type, normalized, stride, offset);
  }

  vertexAttrib1f(index: number, x: number): void {
    this.writer.vertexAttrib1f(index, x);
  }

  vertexAttrib2f(index: number, x: number, y: number): void {
    this.writer.vertexAttrib2f(index, x, y);
  }

  vertexAttrib3f(index: number, x: number, y: number, z: number): void {
    this.writer.vertexAttrib3f(index, x, y, z);
  }

  vertexAttrib4f(index: number, x: number, y: number, z: number, w: number): void {
    this.writer.vertexAttrib4f(index, x, y, z, w);
  }

  vertexAttrib1fv(index: number, v: NumericArg): void {
    this.writer.vertexAttrib1fv(index, toArray(v));
  }

  vertexAttrib2fv(index: number, v: NumericArg): void {
    this.writer.vertexAttrib2fv(index, evenCount(toArray(v), 2, 'vertexAttrib2fv'));
  }

  vertexAttrib3fv(index: number, v: NumericArg): void {
    this.writer.vertexAttrib3fv(index, evenCount(toArray(v), 3, 'vertexAttrib3fv'));
  }

  vertexAttrib4fv(index: number, v: NumericArg): void {
    this.writer.vertexAttrib4fv(index, evenCount(toArray(v), 4, 'vertexAttrib4fv'));
  }

  // -- uniform -------------------------------------------------------------

  uniform1i(location: Resource, x: number): void {
    this.writer.uniform1i(resourceId(location), x);
  }

  uniform2i(location: Resource, x: number, y: number): void {
    this.writer.uniform2i(resourceId(location), x, y);
  }

  uniform3i(location: Resource, x: number, y: number, z: number): void {
    this.writer.uniform3i(resourceId(location), x, y, z);
  }

  uniform4i(location: Resource, x: number, y: number, z: number, w: number): void {
    this.writer.uniform4i(resourceId(location), x, y, z, w);
  }

  uniform1f(location: Resource, x: number): void {
    this.writer.uniform1f(resourceId(location), x);
  }

  uniform2f(location: Resource, x: number, y: number): void {
    this.writer.uniform2f(resourceId(location), x, y);
  }

  uniform3f(location: Resource, x: number, y: number, z: number): void {
    this.writer.uniform3f(resourceId(location), x, y, z);
  }

  uniform4f(location: Resource, x: number, y: number, z: number, w: number): void {
    this.writer.uniform4f(resourceId(location), x, y, z, w);
  }

  uniform1iv(location: Resource, v: NumericArg): void {
    this.writer.uniform1iv(resourceId(location), toArray(v));
  }

  uniform2iv(location: Resource, v: NumericArg): void {
    this.writer.uniform2iv(resourceId(location), evenCount(toArray(v), 2, 'uniform2iv'));
  }

  uniform3iv(location: Resource, v: NumericArg): void {
    this.writer.uniform3iv(resourceId(location), evenCount(toArray(v), 3, 'uniform3iv'));
  }

  uniform4iv(location: Resource, v: NumericArg): void {
    this.writer.uniform4iv(resourceId(location), evenCount(toArray(v), 4, 'uniform4iv'));
  }

  uniform1fv(location: Resource, v: NumericArg): void {
    this.writer.uniform1fv(resourceId(location), toArray(v));
  }

  uniform2fv(location: Resource, v: NumericArg): void {
    this.writer.uniform2fv(resourceId(location), evenCount(toArray(v), 2, 'uniform2fv'));
  }

  uniform3fv(location: Resource, v: NumericArg): void {
    this.writer.uniform3fv(resourceId(location), evenCount(toArray(v), 3, 'uniform3fv'));
  }

  uniform4fv(location: Resource, v: NumericArg): void {
    this.writer.uniform4fv(resourceId(location), evenCount(toArray(v), 4, 'uniform4fv'));
  }

  uniformMatrix2fv(location: Resource, transpose: boolean, v: NumericArg): void {
    this.writer.uniformMatrix2fv(resourceId(location), transpose, toArray(v));
  }

  uniformMatrix3fv(location: Resource, transpose: boolean, v: NumericArg): void {
    this.writer.uniformMatrix3fv(resourceId(location), transpose, toArray(v));
  }

  uniformMatrix4fv(location: Resource, transpose: boolean, v: NumericArg): void {
    this.writer.uniformMatrix4fv(resourceId(location), transpose, toArray(v));
  }

  // -- draw ----------------------------------------------------------------

  clear(mask: number): void {
    this.writer.clear(mask);
  }

  drawArrays(mode: number, first: number, count: number): void {
    this.writer.drawArrays(mode, first, count);
  }

  drawElements(mode: number, count: number, type: number, offset: number): void {
    this.writer.drawElements(mode, count, type, offset);
  }

  finish(): void {
    this.writer.finish();
  }

  flush(): void {
    this.writer.flush();
  }

  // -- framebuffer ---------------------------------------------------------

  framebufferTexture2D(
    target: number,
    attachment: number,
    textarget: number,
    texture: Resource,
    level: number,
  ): void {
    this.writer.framebufferTexture2D(
      target,
      attachment,
      textarget,
      resourceId(texture),
      level,
    );
  }

  framebufferRenderbuffer(
    target: number,
    attachment: number,
    renderbuffertarget: number,
    renderbuffer: Resource,
  ): void {
    this.writer.framebufferRenderbuffer(
      target,
      attachment,
      renderbuffertarget,
      resourceId(renderbuffer),
    );
  }

  renderbufferStorage(
    target: number,
    internalformat: number,
    width: number,
    height: number,
  ): void {
    this.writer.renderbufferStorage(target, internalformat, width, height);
  }

  checkFramebufferStatus(target: number): number {
    return this.q<number>('checkFramebufferStatus', target) ?? 0;
  }

  // -- queries (synchronous, over invokeHost) ------------------------------

  getError(): number {
    return this.q<number>('getError') ?? 0;
  }

  getAttribLocation(program: Resource, name: string): number {
    return this.q<number>('getAttribLocation', resourceId(program), name) ?? -1;
  }

  getUniformLocation(program: Resource, name: string): FjsWebGLObject | null {
    const id = this.q<number>('getUniformLocation', resourceId(program), name);
    return typeof id === 'number' && id > 0
      ? new FjsWebGLObject('WebGLUniformLocation', id)
      : null;
  }

  /** A scalar pname returns a number; an array pname (VIEWPORT, DEPTH_RANGE,
   * SCISSOR_BOX, COLOR_CLEAR_VALUE, …) returns number[]. */
  getParameter(pname: number): number | number[] | boolean | null {
    const result = this.q<number | number[] | boolean | string | null>(
      'getParameter',
      pname,
    );
    return this.unpackMaybeJson(result);
  }

  getContextAttributes(): Record<string, boolean> | null {
    return this.q<Record<string, boolean>>('getContextAttributes') ?? null;
  }

  /** Registered extensions only — and none are registered (spec 021 §2). */
  getSupportedExtensions(): string[] {
    return this.q<string[]>('getSupportedExtensions') ?? [];
  }

  getExtension(name: string): null {
    warnWebglOnce(
      `webgl-ext-${name}`,
      `gl.getExtension("${name}") is not supported by fjs; see ` +
        'docs/canvas-compat.md. Returning null on both Flutter and web.',
    );
    return null;
  }

  getShaderParameter(shader: Resource, pname: number): number | boolean | null {
    return this.unpackMaybeJson<number | boolean | null>(
      this.q<number | boolean | string | null>(
        'getShaderParameter',
        resourceId(shader),
        pname,
      ),
    );
  }

  getProgramParameter(
    program: Resource,
    pname: number,
  ): number | boolean | null {
    return this.unpackMaybeJson<number | boolean | null>(
      this.q<number | boolean | string | null>(
        'getProgramParameter',
        resourceId(program),
        pname,
      ),
    );
  }

  getShaderInfoLog(shader: Resource): string | null {
    return this.q<string | null>('getShaderInfoLog', resourceId(shader));
  }

  getProgramInfoLog(program: Resource): string | null {
    return this.q<string | null>('getProgramInfoLog', resourceId(program));
  }

  getShaderSource(shader: Resource): string | null {
    return this.q<string | null>('getShaderSource', resourceId(shader));
  }

  /** `{ name, size, type }` on both platforms. */
  getActiveAttrib(program: Resource, index: number): { name: string; size: number; type: number } | null {
    return this.q<{ name: string; size: number; type: number } | null>(
      'getActiveAttrib',
      resourceId(program),
      index,
    );
  }

  getActiveUniform(program: Resource, index: number): { name: string; size: number; type: number } | null {
    return this.q<{ name: string; size: number; type: number } | null>(
      'getActiveUniform',
      resourceId(program),
      index,
    );
  }

  getUniform(program: Resource, location: Resource): number | number[] | null {
    return this.unpackMaybeJson<number | number[] | null>(
      this.q<number | number[] | string | null>(
        'getUniform',
        resourceId(program),
        resourceId(location),
      ),
    );
  }

  getVertexAttrib(index: number, pname: number): number | number[] | null {
    return this.unpackMaybeJson<number | number[] | null>(
      this.q<number | number[] | string | null>('getVertexAttrib', index, pname),
    );
  }

  getBufferParameter(target: number, pname: number): number | null {
    return this.q<number | null>('getBufferParameter', target, pname);
  }

  getFramebufferAttachmentParameter(
    target: number,
    attachment: number,
    pname: number,
  ): number | null {
    return this.q<number | null>(
      'getFramebufferAttachmentParameter',
      target,
      attachment,
      pname,
    );
  }

  getRenderbufferParameter(target: number, pname: number): number | null {
    return this.q<number | null>('getRenderbufferParameter', target, pname);
  }

  isBuffer(res: Resource): boolean {
    return this.q<boolean>('isBuffer', resourceId(res)) === true;
  }

  isTexture(res: Resource): boolean {
    return this.q<boolean>('isTexture', resourceId(res)) === true;
  }

  isProgram(res: Resource): boolean {
    return this.q<boolean>('isProgram', resourceId(res)) === true;
  }

  isShader(res: Resource): boolean {
    return this.q<boolean>('isShader', resourceId(res)) === true;
  }

  isFramebuffer(res: Resource): boolean {
    return this.q<boolean>('isFramebuffer', resourceId(res)) === true;
  }

  isRenderbuffer(res: Resource): boolean {
    return this.q<boolean>('isRenderbuffer', resourceId(res)) === true;
  }

  isContextLost(): boolean {
    return false;
  }

  /** The host answers JSON strings for the queries whose GL type can be a
   * list; scalars pass through untouched. The call sites know which GL type
   * the pname returns — hence the generic. */
  private unpackMaybeJson<T>(
    value: number | number[] | boolean | string | null,
  ): T {
    if (typeof value !== 'string') return value as T;
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as T;
      if (typeof parsed === 'number' || typeof parsed === 'boolean') {
        return parsed as T;
      }
      return null as T;
    } catch {
      return null as T;
    }
  }
}

/** What pages type against: the context plus the GL constants, mirroring
 * the DOM's WebGLRenderingContext shape. */
export type FjsWebGLRenderingContextWithConstants =
  FjsWebGLRenderingContext & typeof GL;

// The DOM's context carries the GL constants as instance properties; attach
// them to the prototype once so `gl.VERTEX_SHADER` works the same here.
// (Dropping this line is exactly the "type must be VERTEX_SHADER or
// FRAGMENT_SHADER" + failed-link cascade — fixed during 022's iOS run.)
Object.assign(FjsWebGLRenderingContext.prototype, GL);

/** The factory the core registry calls for 'webgl'/'webgl2'. Narrowing the
 * core surface to what this module needs is a structural cast: the core
 * never names this module. */
export function createWebglContext(
  target: CanvasContextTarget,
): unknown {
  if (target.domCanvas) return target.domCanvas.getContext('webgl');
  if (!target.surface) return null;
  // One webgl context per canvas; the node id is the host-side key for the
  // sync-query channel (fjs.webgl.*).
  const surface = target.surface as unknown as WebglSurface;
  return new FjsWebGLRenderingContext(surface, surface.nodeId);
}

export function createWebgl2Context(
  target: CanvasContextTarget,
): unknown {
  if (target.domCanvas) return target.domCanvas.getContext('webgl2');
  return createWebglContext(target);
}
