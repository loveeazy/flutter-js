# Plan: three.js glTF 示例（Xbot.glb + 拖拽旋转）

对应 spec：`./spec.md`

## 1. 宪法自查

| 条款 | 是否涉及 | 怎么满足 |
|------|---------|---------|
| I 两端同源 | 是 | 同一份页面源码跑两端；polyfill 仅 native 安装，web 用原生 API |
| II 边界即契约 | 是 | webgl 子协议两条半（protocol.ts + replay.dart）同步改；同步查询加进 `fjs.webgl.*` 注册表 |
| III 同步单线程零序列化 | 是 | 纹理解码走 fetch 范式（fjs.canvas.loadImage 事件回调），不加 JSON 桥 |
| IV 外观照 WeUI | 否 | 示例页沿用 hello-fjs 现有 Panel 风格 |
| V 静默失效是 bug | 是 | 模型加载失败显示在 Panel 上；texImage2D 源类型错误已有 warnWebglOnce |
| VI 注释记录权衡 | 是 | polyfill/协议注释写明"为什么"（见本文件 §3 被否方案） |
| VII JS 能包就不要下 Dart | 是 | 页面完全在 JS 侧；Dart 只补 GL 能力（协议命令）与图片解码分支 |
| VIII 变更要落到文档 | 是 | docs/toolchain.md 资产类型说明、docs/web.md 数据 URL 差异登记（如需要） |

## 2. 涉及的层

| 层 | 文件 | 改什么 |
|----|------|--------|
| CLI / 构建 | `packages/fjs/src/bundler/build.ts` | ASSET_LOADERS 加 `.glb` |
| CLI / 构建 | `packages/fjs/src/vite.ts`（fjs() 插件） | assetsInclude 补 .glb |
| JS runtime | `packages/fjs-runtime/src/static-assets.d.ts` | 声明 `*.glb` |
| JS runtime | `packages/fjs-runtime/src/index.ts` | 导出 `utf8Decode` |
| JS runtime | `packages/fjs-runtime/src/web/`（如 vite 插件在别处则相应文件） | — |
| 模块 | `packages/fjs-webgl/src/protocol.ts` | VAO 三命令 + flipY 标志位 |
| 模块 | `packages/fjs-webgl/src/context.ts` | createVertexArray 等 + flipY 客户端记录 |
| 模块 | `packages/fjs-webgl/flutter/lib/src/replay.dart` | VAO 命令执行 + getShaderPrecisionFormat + flipY 行翻转 |
| 模块 | `packages/fjs-webgl/flutter/lib/fjs_webgl.dart` | 同步查询注册表加 getShaderPrecisionFormat |
| Dart 宿主 | `packages/flutter_fjs/lib/src/widgets/image.dart` | data: URL → MemoryImage |
| 示例 | `examples/hello-fjs/package.json`、`src/three/native-polyfills.ts`、`src/pages/example/three-gltf.vue`、`src/assets/Xbot.glb` | 示例本体 |

## 3. 方案

- **VAO**：协议命令（0x030A–0x030C），资源 id 沿用客户端分配，Dart 侧映射
  到 flutter_angle 的 VAO。被否：JS 客户端模拟 VAO（要引入 ARRAY_BUFFER
  状态跟踪，破坏"无客户端状态机"设计）。
- **getShaderPrecisionFormat**：走同步查询（flutter_angle 已有）。被否：
  JS 常量（兜底方案，若 flutter_angle 签名不合手再退）。
- **内嵌纹理链路**（GLTFLoader 的真实路径）：
  GLB bufferView → `new Blob([bytes],{type})` → `URL.createObjectURL` →
  ImageBitmapLoader `fetch(blobUrl)` → `createImageBitmap(blob)` →
  `texture.image` → three `texImage2D(…, image)`。
  polyfill 对应：Blob=内存字节桶；createObjectURL 返回 `fjs-blob:<id>`；
  fetch 包装拦截该协议；createImageBitmap → base64 data URL →
  `loadCanvasImage`（宿主解码，事件回调）→ 返回 `FjsCanvasImage` 实例
  （context.ts 的 texImage2D 用 instanceof 判源，协议现成）。
- **data: URL 图片源**：`fjsResolveImageSource` 加 base64 分支 → MemoryImage。
  web 端浏览器原生支持，两端语义一致。
- **flipY**：context.ts 客户端只记录 `UNPACK_FLIP_Y_WEBGL` 这一个 pixelStorei
  参数（唯一破例，注释说明：three 对图片纹理必设它，而 Dart 侧无状态机），
  编进 TexImage2DSource 命令；Dart 上传前按行翻转。先实测 ANGLE 原生行为，
  若原生已兑现 flipY 则客户端记录恒 false、行翻转为空转，协议字段保留。

## 4. 风险

- **flipY 双重翻转**：若 ANGLE 已处理而 Dart 又翻 → 纹理倒置。以真机实测
  为准，协议字段设计成"显式 true 才翻"。
- **three 与 QuickJS 兼容性**（getter/setter、ES 语法、`navigator` 访问）：
  r170 已核对 FileLoader/GLTFLoader/ImageBitmapLoader 路径；polyfill 里补
  navigator 兜底。
- **字节码体积**：three 核心 + GLTFLoader ≈ echarts 量级，已有先例。
- **caches/性能**：three 初始化有几十次同步查询，每次一次 ABI 往返，一次性
  成本；渲染循环只有指令流。

## 5. 验证路径

```bash
pnpm install                                # three 依赖
pnpm run typecheck && pnpm test             # runtime + webgl 协议测试
pnpm --filter hello-fjs run build           # 字节码构建
pnpm --filter hello-fjs run dev:web         # 浏览器验收 /example/three-gltf
pnpm --filter hello-fjs run dev             # fjs-go / 真机验收（flipY 实测）
cd packages/flutter_fjs/native && cmake --build build-native && ./build-native/fjs-test
```
