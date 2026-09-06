# @ufjs/webgl:WebGL 抽成独立模块

> 依仓库模块规范(docs/modules.md,照 fjs-iconmind / fjs-webview 同构)。先写 spec(sps/022-webgl-module),再实施。WebGL 不是刚需:装了才有,不装两端 `getContext('webgl')` 一致返回 null + 告警(宪法 I 不破)。真正的体积大头是 ANGLE 原生库,移出 flutter_fjs 后不装模块的 app 完全不背。

## 新包结构(packages/fjs-webgl,进 pnpm-workspace)

```
package.json    fjs:{module:true, flutter:{package:'fjs_webgl', path:'./flutter',
                import:'package:fjs_webgl/fjs_webgl.dart', register:'FjsWebgl.register(engine)'}}
                peerDependencies: @ufjs/runtime >=0.1.4(无 vue 依赖——没有组件)
index.ts        副作用注册:registerContextType('webgl'/'webgl2', factory)
                + 导出 GL 常量、FjsWebGLRenderingContext 类型
src/protocol.ts ← runtime 的 canvas/webgl/protocol.ts(WebglCmd/WebglChunkWriter)
src/context.ts  ← runtime 的 canvas/webgl/context.ts
flutter/        pub 包 fjs_webgl:decoder + bindings + manager + Texture view +
                fjs.webgl.* host 模块;pubspec 依赖 flutter_fjs ^0.1.4 + flutter_angle 0.1.0
                (自带 dependency_overrides 供本包 flutter test,照 webview 抄)
test/           vitest + flutter test,随代码从 runtime/flutter_fjs 迁入
```

hello-fjs:`@ufjs/webgl: workspace:*` 依赖 + webgl 页 `import '@ufjs/webgl'`(不 import 的页面树摇掉);`.fjs` 宿主由 autolink 自动加 fjs_webgl。demo 不依赖。

## runtime JS 侧(保留协议,倒出接缝)

- **留**:`ops.ts` 的 `UiOp.Webgl=11` + `writer.webgl()`(op 协议三处同步留在 core);`image.ts` 尺寸事件 dpr 字段;注册表单类型占用规则。
- **抽走**:`canvas/webgl/` 整目录;`context-registry.ts` 的 webgl/webgl2 注册(未装模块回到 warn-once + null,两端一致);`index.ts` 的 webgl 导出。
- **新接缝**(surface.ts):`FjsCanvasSurface` 删掉 webglWriter,改为通用 op 扩展槽:
  `attachOpWriter(w: {takeChunks(): Uint8Array[]; write(id, chunk): void})` + `markDirty()`;`flush()` 逐扩展 take+write。core 不感知 op 11 归谁。
- **新导出**(index.ts,版本 0.1.3→0.1.4):`ByteBuf`、`flushNow`、`type CanvasSurface`、`type CanvasContextTarget`。

## flutter_fjs Dart 侧(同样倒置)

- **留**:op 11 解码(ui_ops/engine v5/fjsrun)、`MirrorNode` 上 op 11 的 chunk 保留(改为纯数据 `webglChunks: List<Uint8List>`,不再持有模块类型)。
- **新接缝**(新文件 `canvas/canvas_module.dart`,barrel 导出):
  `canvasDisplayOverride(node, dispatch) → Widget?`(canvas widget 分流)、
  `canvasReadback(requestId, nodeId, report)`(toDataURL 分支)、
  `canvasNodeDisposed(nodeId)`(_removeDeep/clear 释放)——全部由模块 register 时安装。
- **抽走**:`webgl_replay.dart` 整文件、engine 的 registerWebglHostModules、pubspec 的 flutter_angle(0.1.3→0.1.4)。
- **barrel 新导出**:`CanvasChunkReader`/`CanvasOpException`(canvas_ops)、`FjsCanvasImages`(rgba 缓存留在 core)、接缝三件套。

## 模块 Dart 侧 register(engine) 做的事

`engine.host.register('fjs.webgl.*')` ×25(照搬现 query 分派)、安装三个 canvas 接缝、内部持有每节点状态(句柄表/纹理/资源表)。MirrorNode 信号驱动 widget 重建的机制不变;热重载失效照 iconmind 的 addListener 模式。

## 实施顺序

1. spec 三件套。
2. runtime JS:接缝 + 抽离 + 导出调整;测试迁移(webgl 协议测试 → 模块包;canvas-context 测试回到"未注册→null+warn")。
3. fjs-webgl npm 包搭建(vitest 配置照 webview 抄)。
4. flutter_fjs:接缝 + 抽离 + barrel/pubspec;解码测试迁到模块包,core 补 op11 解码为纯数据的小测试。
5. fjs-webgl flutter 包 + hello-fjs 接线(workspace 依赖、页面 import)。
6. 端到端:重跑 `fjs run ios`(autolink 生成宿主)看三角形;web 端复验;对照 webgl 页移除 import 后两端一致 null。
7. 文档:modules.md 补例、canvas-compat/ui-api/roadmap 注明"需 @ufjs/webgl"。
8. 回归:pnpm typecheck/test、flutter analyze/test、`fjs build --pages` 体积对照。

## 验收

- 不装模块:`getContext('webgl')` 两端 null + 恰好一条告警;demo/shared.js 不含 webgl 代码,flutter_fjs 不再依赖 flutter_angle。
- 装模块:同一 webgl.vue 在 web 与 iOS 模拟器照常渲染(现有验收不回归)。
- `fjs modules` 能列出 @ufjs/webgl 的标签与 autolink。