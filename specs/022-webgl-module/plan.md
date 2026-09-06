# Plan: @ufjs/webgl 模块抽取

顺序即实施顺序。原则:**core 留协议与接缝,模块搬实现**;每步做完即全量回归,
两端最终联调放最后。

## 1. runtime JS(0.1.4)

1. `canvas/surface.ts`:删 webglWriter/WebglSurface;加
   `attachOpWriter(w)` / `markDirty()`;flush 循环改为「2d writer + 逐 op
   扩展」;dpr 逻辑不动。
2. `canvas/context-registry.ts`:删 webgl/webgl2 注册与相关 import
   (单类型占用规则、warn-once 原样)。
3. `index.ts`:删 webgl 导出;加 `ByteBuf`、`flushNow`、
   `type CanvasSurface`、`type CanvasContextTarget`;版本 → 0.1.4。
4. 删 `src/canvas/webgl/` 整目录(内容搬去模块)。
5. 测试:`canvas-context.test.ts` 的 webgl 用例改为「未注册 → null +
   恰好一条告警」「探测 null 不占用」;`webgl-protocol.test.ts` 迁出。

## 2. fjs-webgl npm 包

1. 目录 + package.json(manifest 同 §3,peerDeps @ufjs/runtime >=0.1.4;
   devDeps vitest/typescript;vitest.config + tsconfig 照 webview 抄)。
2. `src/protocol.ts`、`src/context.ts` 从 runtime 迁入;import 改为
   `@ufjs/runtime`(ByteBuf/flushNow/CanvasContextTarget)与本模块相对路径;
   `WebglSurface` 接口改为对 core surface 的结构化窄化
   (nodeId/width/height/devicePixelRatio/attachOpWriter/markDirty)。
3. `index.ts`:副作用 `registerContextType('webgl'/'webgl2', factory)`;
   导出 GL、FjsWebGLRenderingContext(WithConstants)、registerWebgl(幂等)。
4. 测试:`webgl-protocol.test.ts` 迁入(读 runtime 的 pnpm 链接);
   新增「未注册时两端 null」在 runtime 侧、注册后两端形状一致在模块侧。

## 3. flutter_fjs Dart(0.1.4)

1. 新 `canvas/canvas_module.dart`:三个可空回调 + 注释(谁在何时安装)。
2. `mirror_tree.dart`:`MirrorNode.webgl: FjsWebglDisplay?` →
   `webglChunks: List<Uint8List>`(op 11 append + touch);释放点改调
   `canvasNodeDisposed`;删 webgl_replay import。
3. `widgets/canvas.dart`:build 开头问 `canvasDisplayOverride`;删 webgl 分支
   widget(迁模块)。
4. `canvas/host_module.dart`:toDataURL 开头问 `canvasReadback`(节点有
   chunk 时);删 webgl import。
5. `engine.dart`:删 registerWebglHostModules 调用;删对应 import。
6. `pubspec.yaml`:删 flutter_angle;版本 → 0.1.4。
7. barrel `flutter_fjs.dart`:导出 canvas_module 三回调、CanvasChunkReader、
   CanvasOpException、FjsCanvasImages。
8. `webgl_replay.dart` 删除;`webgl_replay_test.dart` 迁模块包;新增 core
   小测试:op 11 解码 → webglChunks 纯数据 + touch(op 帧手写,照
   ops_intern.test 的模式)。

## 4. fjs-webgl flutter 包

1. `flutter/pubspec.yaml`:name fjs_webgl;deps flutter / flutter_fjs ^0.1.4 /
   flutter_angle 0.1.0;dev: flutter_test + dependency_overrides
   flutter_fjs → ../../flutter_fjs(照 webview 注释写明仅供本包测试)。
2. `flutter/lib/fjs_webgl.dart`(可拆 webgl/ 子文件):原 webgl_replay.dart
   内容 + FjsWebgl.register(engine)(host 模块 ×25、三接缝、addListener
   失效)+ _FjsWebglView widget(原 widgets/canvas.dart 的 webgl 视图,
   LayoutBuilder/MediaQuery dpr/pump 逻辑原样)。import 全部改
   `package:flutter_fjs/flutter_fjs.dart`。
3. `flutter/test/`:解码 fake-bindings 测试迁入 + register 冒烟测试。

## 5. hello-fjs 接线

1. package.json deps += `@ufjs/webgl: workspace:*`;pnpm install。
2. `pages/example/webgl.vue`:顶部 `import '@ufjs/webgl';`,类型/常量改从
   `@ufjs/webgl` 导入。
3. `.fjs` 宿主不手改:`fjs run ios` 时 autolink 自动写入 fjs_webgl 路径依赖
   与 `FjsWebgl.register(engine);`。

## 6. 端到端与文档

1. iOS:杀旧会话 → `fjs run ios`(autolink 重建宿主)→ 模拟器看三角形
   旋转(照 021 的截图法);`fjs modules` 输出核对。
2. web:vite 起服务复验;再临时注释 import 验证「两端一致 null + 告警」。
3. 文档:modules.md 完整例子区加 @ufjs/webgl;canvas-compat(§1 表 + §3.5
   注明模块前置)、ui-api 标签表、roadmap 021 条目补一句。
4. 回归:pnpm typecheck/test、flutter analyze/test(fjs-webgl 与
   flutter_fjs)、`fjs build --pages` 体积对照(记录 shared.js 前后差)。

## 风险

- 模块 import 的副作用注册依赖「页面 import 才进包」:echarts/tetris 等
  未 import 模块的页面不背体积 ✓;但 shared.js 若被某页引入则全体共享
  一份实例(模块机制既有行为,可接受)。
- runtime 0.1.4 的导出面变化对 iconmind/webview 无影响(peer 范围
  >=0.1.3 仍满足)。
- autolink 的 dependency_overrides 只指向 flutter_fjs;fjs_webgl 的
  flutter_angle 由它自己 pubspec 钉 0.1.0,宿主解析即可。
