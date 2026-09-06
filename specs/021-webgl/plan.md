# Plan: canvas WebGL 上下文

按层组织,顺序即实现顺序。三层必须保持协议同步(op 11):
`fjs-runtime/src/canvas/webgl/protocol.ts` ↔ `flutter_fjs/lib/src/canvas/webgl_replay.dart`
(↔ `fjsrun.cpp` 只 dump 长度,不解码)。

## 1. 协议层(op 11 的 payload 编码)

WebGL 指令流是与 2d 显示列表同风格的二进制 chunk(小端、f32、字符串按 chunk
intern、绘制数据内联),但**语义不同**:2d chunk 是「重放」(宿主保留),
webgl chunk 是「执行」(到达即跑进 FBO,不留存)。编号用 u16 给 WebGL2 留空间,
按指令家族分段:

```
0x0000-0x00ff  杂项/字符串定义(StrDef 0x0001,同 2d 的形状)
0x0100-0x01ff  资源生命周期 create/delete(buffer/texture/program/shader/fbo/rbo)
0x0200-0x02ff  绑定与状态 bind*/enable/disable/blend*/clearColor/depth*/.../viewport
0x0300-0x03ff  数据上传 bufferData/bufferSubData/texImage2D/texSubImage2D/...
0x0400-0x04ff  program 编译链接 shaderSource/compileShader/linkProgram/attachShader/...
0x0500-0x05ff  顶点与 uniform vertexAttribPointer/uniform*/uniformMatrix*
0x0600-0x06ff  绘制 drawArrays/drawElements/clear/finish/flush
0x0700-0x07ff  FBO framebufferTexture2D/framebufferRenderbuffer/renderbufferStorage
0x0800+        预留(WebGL2:VAO 0x0900、instancing 0x0910、查询对象 0x0920)
```

- 每条命令:u16 命令号 + 固定参数形状(枚举/bool→u8,整数→i32,浮点→f32,
  GL 对象→u32 句柄,typed array→u32 byteLen + 字节,字符串→u16 intern id)。
- `bufferData(target, data|size, usage)`:data 形内联字节;size 形只发 u32,
  宿主置零分配。
- `texImage2D` 像素源:target/level/internalformat/format/type + 内联字节;
  `FjsCanvasImage` 源:发 u32 图片 handle(Dart 侧已有 `FjsCanvasImages`
  句柄表,与 2d `drawImage` 共用)。
- 不做状态去重(GL 页面逐帧全量重画的模式与 2d 的增量绘制不同,先保证正确;
  去重留作后续优化,记 roadmap)。

## 2. JS 侧(packages/fjs-runtime/src/canvas/webgl/)

- `protocol.ts`:`WebglCmd` 常量 + `WebglChunkWriter`(复用 `display-list.ts`
  的 `ByteBuf` 与字符串 intern 模式;chunk 关闭时 flush pending)。
- `context.ts`:`FjsWebGLRenderingContext` —— WebGL 1.0 核心(spec §3.5 表):
  - 常量对象按 web 形状暴露(顶级的 gl.CONSTANT 即可,不建独立 `WebGL` 命名
    空间对象);
  - 突变方法 → 编码进 writer → `onDirty()`(复用 surface 的 dirty 集合与
    pre-flush drain);
  - 同步查询 → `invokeHost('fjs.webgl.<method>', ctxId, ...args)`,返回标量或
    JSON 字符串(context 侧解包成类型化数组/对象);
  - 资源句柄:JS 侧每 canvas 分配 u32 id(1 起,0 = null 对象);宿主懒建
    GL 对象(收到引用该 id 的首条命令时);
  - `getUniformLocation` 返回 number 句柄(JS 侧直接当 opaque 值用);
  - `canvas` 属性:暴露 `{width, height}` 位图像素(逻辑 × dpr,来自
    `@resize` 的逻辑尺寸 × 上下文 dpr);
  - `getContextAttributes` 返回 `{alpha:true,antialias:true,...}` 常量。
- `context-registry.ts`:`registerContextType('webgl', factory)`;同一 canvas
  第二种 context 类型 warn-once + null(在 `resolveContext` 里用
  WeakMap<cache, claimedType> 记先到者,null 不算占用)。
- `surface.ts`:`FjsCanvasSurface` 增加 `webglWriter`(惰性创建)与
  `webglVersion`;`flush()` 先发 op 10 chunk 再发 op 11 chunk。`CanvasSurface`
  接口加 webgl 访问器,供工厂取用。
- `ui/ops.ts`:`UiOp.Webgl = 11`、`writer.webgl(id, bytes)`(版本 ≥ 5 检查,
  老宿主 warn-once + 丢弃)、协议注释补 op 11。
- host.ts 的 `__fjsHost` 协商不用改(`uiOpsVersion` 由 Dart 侧给 5)。

## 3. web 侧(packages/fjs-runtime/src/web/)

- `components/canvas.ts`:零改动(注册表工厂的 domCanvas 路径直通浏览器原生
  context;`@resize` 时 webgl 位图随 `canvas.width` 赋值清空,即浏览器语义)。
- `sync()` 里对 `2d` 的 `setTransform` 只在 `2d` 上下文存在时执行(现状已如此,
  webgl 不受影响,验证即可)。

## 4. Dart 侧(packages/flutter_fjs/)

- `lib/src/ui_ops.dart`:`UiOpCode.webgl = 11`;`engine.dart`:
  `uiOpsVersion = 5`;`native/tools/fjsrun.cpp`:dump `webgl #%u %u bytes`。
- `lib/src/mirror_tree.dart`:`MirrorNode.webgl`(`FjsWebglDisplay?`):
  `pending` chunk 队列 + `version`;op 11 解码 append + `_touch(id)`
  (与 op 10 同款);节点删除时释放(`_removeDeep` 路径)。
- `lib/src/canvas/webgl_replay.dart`(**flutter_angle 唯一使用点**):
  - 惰性单例 `FlutterAngle`;每节点一个 `FlutterAngleTexture` + `RenderingContext`;
  - chunk 解码(`WebglChunkReader`,u16 命令分派)→ 逐条调 gl;
  - 资源表:u32 id → GL 对象(懒建);字符串表:chunk 内 u16 → String;
  - 纹理尺寸:逻辑 × dpr,`@resize` 后重建纹理(example 的 debounce 模式);
  - chunk 执行完 `angle.updateTexture` 上屏;执行进 FBO 的调用都在收到 chunk
    时同步做(UI 线程,flutter_angle example 同款);
  - `fjs.webgl.*` 同步查询的应答入口(查询打在当前绑定的上下文状态上)。
- `lib/src/widgets/canvas.dart`:`buildCanvas` 分流——`node.webgl == null` 走
  原 CustomPaint,否则 `_FjsWebglCanvas`(LayoutBuilder 报尺寸(复用
  `_reportSize` 的事件流)+ `Texture(textureId)`);两态切换靠 op 11 的
  `_touch` 触发重建。
- `lib/src/canvas/host_module.dart`:注册 `fjs.webgl.*` 同步模块(转发给
  webgl_replay);`fjs.canvas.toDataURL` 分支:节点有 webgl 显示时
  readPixels → `ImageDescriptor.raw` → PNG → base64(同一事件 30 载荷)。
- pubspec:`flutter_angle`(versions: ^0.4.2);Android minSdk 按 ANGLE 优先
  配置(28,低于回退 GL),iOS 12 / macOS 10.14。

## 5. 测试与示例

- vitest(`packages/fjs-runtime/test/`):协议编码(命令形状、字符串 intern、
  typed array 内联、chunk 切分)、注册表单类型占用规则、老宿主降级。
- `fjs-test`(native):不涉及(native 层只搬运,无解码)——fjsrun dump 加一行
  即可,C++ 不改测试。
- `flutter test`:WebglChunkReader 的纯解码测试(命令分派到 fake bindings,
  不碰真 GL);不是 `No tests ran`。
- `examples/hello-fjs/src/pages/comp/webgl.vue`:清屏 → 彩色三角形 → rAF
  动画;路由/画廊入口按 019 的 canvas 页模式挂。

## 6. 实施顺序与风险闸门

1. **闸门:flutter_angle 可用性**(spec §7.1):先在 hello-fjs 的 Flutter 壳里
   跑通 flutter_angle example 级别的三角形(Texture + resize 重建)。跑不通
   就地升级为「原生 C++ EGL 回退路径」的 plan 修订,不硬上。
2. JS 协议 + 注册表 + surface(纯 TS,可全量单测)。
3. Dart 解码 + fake-bindings 测试(不依赖闸门 1)。
4. Dart flutter_angle 接线 + widget + host 模块。
5. web 放行 + 示例页 + 文档(canvas-compat / ui-api / roadmap)。

## 7. 明确不做(记 roadmap)

- WebGL2、扩展、readPixels、压缩纹理、状态去重优化、OffscreenCanvas、
  上下文丢失模拟、three.js 兼容承诺。
