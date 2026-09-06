# Tasks: @ufjs/webgl 模块抽取

## runtime JS(0.1.4)

- [x] T1 surface.ts:attachOpWriter/markDirty 接缝,删 webglWriter
- [x] T2 context-registry:删 webgl/webgl2 注册
- [x] T3 index.ts:删 webgl 导出,加 ByteBuf/flushNow/CanvasSurface/CanvasContextTarget;版本 0.1.4
- [x] T4 删 src/canvas/webgl/;canvas-context 测试改回未注册语义

## fjs-webgl npm 包

- [x] T5 包骨架(package.json manifest / vitest / tsconfig,进 workspace)
- [x] T6 protocol.ts + context.ts 迁入并改依赖
- [x] T7 index.ts 副作用注册 + 导出;协议测试迁入

## flutter_fjs Dart(0.1.4)

- [x] T8 canvas_module.dart 三接缝;mirror_tree 改纯数据 webglChunks
- [x] T9 widgets/canvas.dart 分流改接缝;host_module toDataURL 改接缝;engine 清理
- [x] T10 pubspec 删 flutter_angle、版本 0.1.4;barrel 新导出;删 webgl_replay
- [x] T11 core op11 解码小测试;解码测试迁模块包

## fjs-webgl flutter 包

- [x] T12 pubspec + lib/(decoder/bindings/manager/view/register)
- [x] T13 flutter test(fake bindings + register 冒烟)

## 接线与端到端

- [x] T14 hello-fjs 依赖 + 页面 import;.fjs 宿主 autolink 验证(fjs modules)
- [x] T15 iOS 模拟器复验;web 复验;不装模块对照(null+告警)
- [x] T16 文档(modules/canvas-compat/ui-api/roadmap)
- [x] T17 全量回归 + build:pages 体积对照
