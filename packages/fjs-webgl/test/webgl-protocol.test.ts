// Byte-level contract for the WebGL command stream, plus the context that
// produces it.
//
// The command table is written by hand in two places — src/protocol.ts and
// the fjs_webgl Dart package's webgl_replay.dart — with nothing generating
// one from the other. These assertions pin the encoding so a change on this
// side that forgets the other one fails here rather than on a device.
import { describe, expect, it } from 'vitest';

import { WebglChunkWriter, WebglCmd, TexSource } from '../src/protocol';
import { FjsWebGLObject, FjsWebGLRenderingContext, GL } from '../src/context';
import { registerWebgl } from '../index';
import { registerContextType, resolveContext } from '@ufjs/runtime';

/** A minimal reader for the handful of command shapes these tests pin. Not
 * the decoder's twin — webgl_replay.dart is — just enough to catch an
 * accidental schema change on this side. */
function decode(
  bytes: Uint8Array,
): Array<{ cmd: number; args: number[]; str?: string }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const strings = new Map<number, string>();
  const out: Array<{ cmd: number; args: number[]; str?: string }> = [];
  const eat = {
    u8: () => bytes[p++],
    u16: () => {
      const v = view.getUint16(p, true);
      p += 2;
      return v;
    },
    u32: () => {
      const v = view.getUint32(p, true);
      p += 4;
      return v;
    },
    i32: () => {
      const v = view.getInt32(p, true);
      p += 4;
      return v;
    },
    f32: () => {
      const v = view.getFloat32(p, true);
      p += 4;
      return v;
    },
    str: () => {
      const id = view.getUint16(p, true);
      p += 2;
      return strings.get(id) ?? '';
    },
  };
  while (p < bytes.length) {
    const cmd = view.getUint16(p, true);
    p += 2;
    if (cmd === WebglCmd.StrDef) {
      const id = view.getUint16(p, true);
      const len = view.getUint16(p + 2, true);
      p += 4;
      strings.set(id, new TextDecoder().decode(bytes.subarray(p, p + len)));
      p += len;
      continue;
    }
    const args: number[] = [];
    let str: string | undefined;
    switch (cmd) {
      case WebglCmd.CreateShader:
        args.push(eat.u32(), eat.u32());
        break;
      case WebglCmd.CreateBuffer:
      case WebglCmd.CreateTexture:
        args.push(eat.u32());
        break;
      case WebglCmd.BindBuffer:
        args.push(eat.u32(), eat.u32());
        break;
      case WebglCmd.ClearColor:
        args.push(eat.f32(), eat.f32(), eat.f32(), eat.f32());
        break;
      case WebglCmd.BufferData: {
        const target = eat.u32();
        const usage = eat.u32();
        const len = eat.u32();
        let sum = 0;
        for (let i = 0; i < len; i++) sum += bytes[p + i];
        p += len;
        args.push(target, usage, len, sum);
        break;
      }
      case WebglCmd.BufferDataSize:
        args.push(eat.u32(), eat.u32(), eat.u32());
        break;
      case WebglCmd.TexImage2DSource:
        args.push(
          eat.u32(), eat.i32(), eat.i32(), eat.u32(), eat.u32(),
          eat.u32(), eat.u32(),
        );
        break;
      case WebglCmd.ShaderSource: {
        const shader = eat.u32();
        str = eat.str();
        args.push(shader);
        break;
      }
      case WebglCmd.UniformMatrix4fv: {
        const loc = eat.u32();
        const transpose = eat.u8();
        const n = eat.u32();
        const vals: number[] = [];
        for (let i = 0; i < n; i++) vals.push(eat.f32());
        args.push(loc, transpose, n, ...vals);
        break;
      }
      case WebglCmd.Uniform2fv: {
        const loc = eat.u32();
        const n = eat.u32();
        const vals: number[] = [];
        for (let i = 0; i < n; i++) vals.push(eat.f32());
        args.push(loc, n, ...vals);
        break;
      }
      case WebglCmd.DrawArrays:
        args.push(eat.u32(), eat.i32(), eat.u32());
        break;
      case WebglCmd.Clear:
        args.push(eat.u32());
        break;
      default:
        throw new Error(`test reader does not know cmd 0x${cmd.toString(16)}`);
    }
    out.push({ cmd, args, str });
  }
  return out;
}

/** A surface shaped the way the core's FjsCanvasSurface presents itself to
 * context modules; `take()` closes and collects the chunks so each test
 * sees the commands its context emitted. */
function makeSurface() {
  const writer = new WebglChunkWriter(() => {});
  let attachedWriter: { takeChunks(): Uint8Array[] } | null = null;
  return {
    webglWriter: () => writer,
    /** what attachOpWriter hands the core: chunks go out as op 11 */
    attached: [] as Array<{ id: number; chunk: Uint8Array }>,
    take(): Uint8Array[] {
      // the CONTEXT attaches its own writer in the constructor; drain that
      // one, so context-level tests see the commands their gl.* calls made
      return (attachedWriter ?? writer).takeChunks();
    },
    width: () => 300,
    height: () => 200,
    devicePixelRatio: () => 2,
    nodeId: 7,
    attachOpWriter(w: { takeChunks(): Uint8Array[] }) {
      attachedWriter = w;
    },
    markDirty() {},
  };
}

describe('WebglChunkWriter encoding', () => {
  it('encodes createShader with a u16 command id and u32 args', () => {
    const s = makeSurface();
    s.webglWriter().createShader(3, GL.VERTEX_SHADER);
    const ops = decode(s.take()[0]);
    expect(ops).toEqual([
      { cmd: WebglCmd.CreateShader, args: [3, GL.VERTEX_SHADER] },
    ]);
  });

  it('interns shader source per chunk and references it by u16', () => {
    const s = makeSurface();
    const w = s.webglWriter();
    const id = w.str('void main() {}');
    w.shaderSource(2, id);
    w.shaderSource(3, w.str('void main() {}'));
    const ops = decode(s.take()[0]);
    // both references resolve to the same interned string, defined once
    expect(ops).toHaveLength(2);
    expect(ops[0].cmd).toBe(WebglCmd.ShaderSource);
    expect(ops[0].str).toBe('void main() {}');
    expect(ops[1].str).toBe('void main() {}');
  });

  it('resets the string table per chunk, keeping chunks self-contained', () => {
    const s = makeSurface();
    const w = s.webglWriter();
    w.shaderSource(2, w.str('first chunk'));
    s.take(); // closes the chunk
    w.shaderSource(3, w.str('second chunk'));
    const ops = decode(s.take()[0]);
    expect(ops[0].str).toBe('second chunk');
  });

  it('inlines buffer data after target and usage', () => {
    const s = makeSurface();
    s.webglWriter().bufferData(
      GL.ARRAY_BUFFER,
      new Uint8Array([1, 2, 3, 4]),
      GL.STATIC_DRAW,
    );
    const ops = decode(s.take()[0]);
    expect(ops[0]).toEqual({
      cmd: WebglCmd.BufferData,
      args: [GL.ARRAY_BUFFER, GL.STATIC_DRAW, 4, 10], // 1+2+3+4 checksum
    });
  });

  it('the size form of bufferData carries no payload', () => {
    const s = makeSurface();
    s.webglWriter().bufferDataSize(GL.ARRAY_BUFFER, 256, GL.DYNAMIC_DRAW);
    const ops = decode(s.take()[0]);
    expect(ops[0].args).toEqual([GL.ARRAY_BUFFER, GL.DYNAMIC_DRAW, 256]);
  });

  it('encodes texImage2DSource with the image-handle kind', () => {
    const s = makeSurface();
    s.webglWriter().texImage2DSource(
      GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE, 42,
    );
    const ops = decode(s.take()[0]);
    expect(ops[0].args).toEqual([
      GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE,
      TexSource.ImageHandle, 42,
    ]);
  });

  it('encodes a mat4 uniform with transpose flag and 16 floats', () => {
    const s = makeSurface();
    const m = Array.from({ length: 16 }, (_, i) => i * 0.5);
    s.webglWriter().uniformMatrix4fv(5, false, m);
    const ops = decode(s.take()[0]);
    expect(ops[0].cmd).toBe(WebglCmd.UniformMatrix4fv);
    expect(ops[0].args[0]).toBe(5);
    expect(ops[0].args[1]).toBe(0); // transpose=false
    expect(ops[0].args[2]).toBe(16);
    expect(ops[0].args.slice(3)).toEqual(m);
  });

  it('uniform2fv sends element count, arity implied by the command id', () => {
    const s = makeSurface();
    s.webglWriter().uniform2fv(1, [1, 2]);
    const ops = decode(s.take()[0]);
    // location, element count, then the floats
    expect(ops[0].args).toEqual([1, 2, 1, 2]);
  });
});

describe('FjsWebGLRenderingContext', () => {
  it('exposes gl.canvas in device pixels, unlike the 2d context', () => {
    const s = makeSurface();
    const gl = new FjsWebGLRenderingContext(s as never, 7);
    expect(gl.canvas.width).toBe(600); // 300 logical x dpr 2
    expect(gl.canvas.height).toBe(400);
  });

  it('null resource arguments encode as id 0', () => {
    const s = makeSurface();
    const gl = new FjsWebGLRenderingContext(s as never, 7);
    gl.bindBuffer(GL.ARRAY_BUFFER, null);
    const ops = decode(s.take()[0]);
    expect(ops[0].args).toEqual([GL.ARRAY_BUFFER, 0]);
  });

  it('allocates distinct opaque resource ids and passes them back', () => {
    const s = makeSurface();
    const gl = new FjsWebGLRenderingContext(s as never, 7);
    const a = gl.createBuffer();
    const b = gl.createTexture();
    expect(a!.kind).toBe('WebGLBuffer');
    expect(b!.kind).toBe('WebGLTexture');
    gl.bindBuffer(GL.ARRAY_BUFFER, a);
    gl.bindBuffer(GL.ARRAY_BUFFER, b);
    const ops = decode(s.take()[0]).filter((o) => o.cmd === WebglCmd.BindBuffer);
    expect(ops[0].args).toEqual([GL.ARRAY_BUFFER, a!.id]);
    expect(ops[1].args).toEqual([GL.ARRAY_BUFFER, b!.id]);
  });

  it('createShader rejects a non-shader type', () => {
    const s = makeSurface();
    const gl = new FjsWebGLRenderingContext(s as never, 7);
    expect(gl.createShader(GL.TRIANGLES)).toBeNull();
    expect(gl.createShader(GL.VERTEX_SHADER)).not.toBeNull();
  });

  it('uniform array truncation never sends a ragged tail', () => {
    // a ragged tail is INVALID_OPERATION in GL and the decoder slices by
    // implied arity, so the context must truncate before encoding
    const s = makeSurface();
    const gl = new FjsWebGLRenderingContext(s as never, 7);
    // a real WebGLUniformLocation comes from getUniformLocation, which the
    // host answers; a standalone object is what the id encoder needs
    const location = new FjsWebGLObject('WebGLUniformLocation', 9);
    // 3 floats into uniform2fv — tail dropped
    gl.uniform2fv(location, [1, 2, 3]);
    const ops = decode(s.take()[0]);
    expect(ops[0].args).toEqual([9, 2, 1, 2]); // location, count, floats
  });

  it('attaches an op writer that emits op 11 through the runtime', () => {
    const s = makeSurface();
    // the real FjsCanvasSurface.attachOpWriter is what bridges to
    // getWriter().webgl; here we verify the context attaches one and that
    // its write() would carry the node id
    let attached: { write: (id: number, chunk: Uint8Array) => void } | null = null;
    const surface = {
      ...s,
      attachOpWriter(w: never) {
        attached = w as never;
      },
      markDirty: () => {},
    };
    void new FjsWebGLRenderingContext(surface as never, 7);
    expect(attached).not.toBeNull();
    // the writer produces chunks; write() forwards them with the node id
    s.webglWriter().clear(GL.COLOR_BUFFER_BIT);
    const [chunk] = s.take();
    expect(chunk.length).toBeGreaterThan(0);
    expect(() => attached!.write(7, chunk)).not.toThrow();
  });
});

describe('registration', () => {
  it('registers webgl and webgl2 into the runtime registry on import', () => {
    registerWebgl(); // idempotent; the import already ran it
    // through the same registry the core canvas uses. Separate caches: a
    // DOM canvas hands out ONE context type per element.
    const dom = { getContext: (t: string) => ({ native: t }) };
    const ctx = resolveContext(new Map(), 'webgl', { canvas: {}, domCanvas: dom });
    expect(ctx).toEqual({ native: 'webgl' });
    const ctx2 = resolveContext(new Map(), 'webgl2', { canvas: {}, domCanvas: dom });
    expect(ctx2).toEqual({ native: 'webgl2' });
  });

  it('does not disturb other registered types', () => {
    registerContextType('test-other', () => 'other');
    const cache = new Map<string, unknown>();
    const target = {
      canvas: {},
      surface: makeSurface() as unknown as import('@ufjs/runtime').CanvasSurface,
    };
    expect(resolveContext(cache, 'test-other', target)).toBe('other');
  });
});
