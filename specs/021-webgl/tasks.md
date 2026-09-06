# Tasks: canvas WebGL 上下文

## 闸门

- [x] T0(web 端 + iOS 模拟器均已验证;Android 真机待验) flutter_angle 在本仓库 Flutter 壳里跑通 example 级三角形
      (Texture 显示 + resize 重建纹理);失败则修订 plan §6,不走后续 Dart 任务

## JS 侧(packages/fjs-runtime)

- [x] T1 `ui/ops.ts`:`UiOp.Webgl = 11`、`writer.webgl()`、版本 ≥5 检查与告警
- [x] T2 `canvas/webgl/protocol.ts`:`WebglCmd` 常量 + `WebglChunkWriter`
- [x] T3 `canvas/webgl/context.ts`:`FjsWebGLRenderingContext`(§3.5 突变面 +
      同步查询解包)
- [x] T4 `canvas/context-registry.ts`:注册 `'webgl'`/`'webgl2'`(见 spec 实现期修订 1);单类型占用规则
- [x] T5 `canvas/surface.ts`:webglWriter / webglVersion / flush 双通道
- [x] T6 vitest:协议编码、注册表规则、老宿主降级

## Dart 侧(packages/flutter_fjs)

- [x] T7 `ui_ops.dart` op 11 + `engine.dart` uiOpsVersion 5 + `fjsrun.cpp` dump
- [x] T8 `mirror_tree.dart`:`MirrorNode.webgl` + op 11 解码 + 释放路径
- [x] T9 `canvas/webgl_replay.dart`:chunk 解码(可注入 bindings)+ 资源表 +
      字符串表;flutter_angle 接线(Texture 生命周期、resize 重建、updateTexture)
- [x] T10 `widgets/canvas.dart`:CustomPaint / Texture 分流
- [x] T11 `host_module.dart`:`fjs.webgl.*` 同步模块 + toDataURL 分支
- [x] T12 `flutter test`:解码测试(fake bindings);确认不是 `No tests ran`

## web 侧与端到端

- [x] T13 验证 web 端 `getContext('webgl')` 直通原生、`@resize` 行为与 2d 一致
- [x] T14 `examples/hello-fjs` webgl 示例页(三角形 + rAF 动画)+ 画廊入口
- [x] T15 文档:canvas-compat.md webgl 一节、ui-api.md、roadmap.md
- [x] T16 回归:`pnpm run typecheck`、`pnpm test`、canvas 2d 页面两端不回归
