# Spec: WebGL 抽成独立模块 @ufjs/webgl

- **ID**: 022-webgl-module
- **状态**: in-progress
- **日期**: 2026-09-06
- **依赖**: 021-webgl(实现已在 core 里,本 spec 把它搬出去)

## 1. 要解决什么

021 把 WebGL 实现进了 `@ufjs/runtime` 与 `flutter_fjs`。但 WebGL 不是刚需:
不用它的 app 被迫背上三份成本——runtime 的 JS 体积、flutter_fjs 的 Dart 代码,
以及最大头的 **flutter_angle(ANGLE 原生库,每平台数 MB)**。

仓库已有标准解法:**模块**([docs/modules.md](../docs/modules.md),
`@ufjs/iconmind` / `@ufjs/webview` 为范例)——一个 npm 包带 JS API 与 Dart 侧,
`package.json` 的 `fjs` 字段声明,装上即 autolink。本 spec 把 021 的实现照
模块规范整体搬出,core 只留协议与接缝。

## 2. 不做什么(Non-goals)

- **不改协议**:op 11、`uiOpsVersion 5`、三处同步(ops.ts / ui_ops.dart /
  fjsrun.cpp)留在 core——协议是引擎契约,不是模块私产。
- **不做懒加载/分包优化**:模块代码跟随 import 树摇;纹理上传大 buffer 的
  chunk 预算、指令去重等仍按 021 登记。
- **不改 2d**:canvas 2d、事件 30、尺寸上报(含 dpr 字段)全在 core。
- 不给 demo 加 webgl 依赖。

## 3. 模块形状

```
packages/fjs-webgl/
  package.json   fjs: {module:true, flutter:{package:'fjs_webgl', path:'./flutter',
                 import:'package:fjs_webgl/fjs_webgl.dart', register:'FjsWebgl.register(engine)'}}
                 peerDependencies: { "@ufjs/runtime": ">=0.1.4" }   ← 无 vue(没有组件)
  index.ts       import 时副作用注册 'webgl'/'webgl2';导出 GL 常量与上下文类型
  src/           protocol.ts(WebglCmd/WebglChunkWriter)、context.ts(上下文)
  flutter/       pub 包 fjs_webgl:decoder/bindings/manager/Texture view +
                 fjs.webgl.* host 模块;依赖 flutter_fjs ^0.1.4 + flutter_angle 0.1.0
  test/          vitest(照 webview 配置)+ flutter test(fake bindings)
```

页面写法:装模块 + `import '@ufjs/webgl'`,其余与 021 完全一致。
不装模块:`getContext('webgl')` 两端 null + 恰好一条告警(注册表既有行为)。

## 4. 两端接缝(依赖倒置)

core 不 import 模块;模块只依赖 core 的公开面。

### JS(runtime 0.1.3 → 0.1.4)

| 接缝 | 形状 |
|---|---|
| op 扩展槽 | `FjsCanvasSurface.attachOpWriter(w: {takeChunks(): Uint8Array[]; write(id, chunk)})` + `markDirty()`;`flush()` 逐扩展 take+write——core 不感知 op 11 归谁 |
| 新导出 | `ByteBuf`(display-list)、`flushNow`(host)、`type CanvasSurface`、`type CanvasContextTarget` |
| 保留 | `registerContextType`、`getWriter().webgl`(op 11)、事件 30 dpr 字段、单类型占用规则 |

### Dart(flutter_fjs 0.1.3 → 0.1.4)

| 接缝 | 形状 |
|---|---|
| 显示分流 | `canvasDisplayOverride(node, dispatch) → Widget?`(canvas widget 在 2d CustomPaint 之前问一次) |
| 导出分流 | `canvasReadback(requestId, nodeId, report)`(toDataURL:节点有 op 11 chunk 时交给模块) |
| 释放 | `canvasNodeDisposed(nodeId)`(_removeDeep / clear 调用) |
| chunk 保留 | `MirrorNode.webglChunks: List<Uint8List>`(纯数据,op 11 解码 append + touch;不再持有模块类型) |
| barrel 新导出 | `CanvasChunkReader` / `CanvasOpException`、`FjsCanvasImages`(rgba 缓存留在 core)、上三者 |

模块 `FjsWebgl.register(engine)`:`engine.host.register('fjs.webgl.*')` ×25 +
安装三个接缝;每节点状态(句柄表/纹理/资源表/乐观应答)收在模块内;
热重载失效照 iconmind 的 `engine.addListener` + generation 模式。

## 5. 契约变更(宪法 II)

- [ ] runtime npm 0.1.3 → 0.1.4(新导出);flutter_fjs pub 0.1.3 → 0.1.4(接缝导出 + 移除 flutter_angle)。
- [ ] op 协议不变(op 11/uiOpsVersion 5 原样)。
- [ ] 新增 npm workspace 包 `packages/fjs-webgl`;hello-fjs 增加 `@ufjs/webgl: workspace:*`。

## 6. 验收标准

1. **不装模块**:`getContext('webgl')` 两端 null + 恰好一条告警;
   `fjs build --pages` 的产物不含 webgl 代码;flutter_fjs pubspec 无
   flutter_angle,宿主不背 ANGLE。
2. **装模块**:hello-fjs 的 webgl 页在 web 与 iOS 模拟器照常渲染旋转三角形
   (021 验收不回归);`fjs modules` 列出 @ufjs/webgl 与 fjs_webgl autolink。
3. `pnpm run typecheck`、`pnpm test`(runtime + 新模块包)、
   `flutter analyze`、`flutter test`(flutter_fjs 与 fjs_webgl)全绿;
   解码测试在模块包内且不是 `No tests ran`。
4. 文档:modules.md 增补 @ufjs/webgl 例;canvas-compat / ui-api / roadmap
   注明"WebGL 需安装 @ufjs/webgl"。

## 7. 待澄清

无。包名(`@ufjs/webgl` / `fjs_webgl`)与目录位置(`packages/fjs-webgl`)
按仓库既有命名法;协议归属 core;demo 不引入。

**实现期修订(iOS 模拟器联调发现,2026-09-06)**:

1. **GL 常量必须挂在上下文原型上**:抽包时丢了
   `Object.assign(prototype, GL)`,`gl.VERTEX_SHADER` 变 undefined,
   createShader 拒绝后整条编译链接链静默断掉——由加宽 `_drain` 异常
   捕获(插件抛的非 CanvasOpException 也不能炸 app)后才定位到。
2. **webgl 视图尺寸必须来自 LayoutBuilder**:纯 webgl 节点从不产生 2d
   显示列表,`node.canvas` 为 null,拿它当尺寸会建出 0×0 纹理
   (flutter_angle 报 Framebuffer incomplete 36054),画布全白。
3. **App 侧呈现要垂直翻转**:GL 帧缓冲自下而上,flutter_angle 的
   CVPixelBuffer 呈现路径不做翻转,和浏览器的自上而下呈现构成镜像,
   表现为旋转方向相反;模块在 Texture 外包一层 flipY 变换补偿,
   页面代码无感。
