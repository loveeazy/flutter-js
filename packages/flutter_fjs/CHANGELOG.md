## 0.1.4

- **最低 Flutter 版本提到 3.38.0（Dart 3.10）。** 更低的版本编译不过：WebGL 模块
  依赖的 flutter_angle 0.4.x 用私有 `@Native` 函数接 TypedData `.address`，
  Dart 3.10 之前的 CFE 会崩在 `Crash when compiling: Null check operator used
  on a null value`。Flutter 3.35（Dart 3.9）同样受影响，升级要一步到 3.38+。
- `flutter_angle` 依赖从核心移到 `@ufjs/webgl` 模块（spec 022）。不用
  `getContext('webgl')` 的应用不再拉 ANGLE。
- `ffi` 提到 `^2.2.0`；`cached_network_image` 放宽成 `>=3.4.1 <5.0.0`，这样在
  Flutter ≥3.44 上会自动用 4.x，而不必在这里锁死一个更高的 SDK 下限。
- Android 侧固定 `ndkVersion`，避免宿主和插件解析到不同的 NDK。

## 0.1.3

- `<canvas>`: a Canvas 2D host. JS sends a display list of drawing commands and
  Dart replays it into a `CustomPainter` — paths, fills and strokes, gradients
  and patterns, text, images, clipping, transforms, and per-frame state. The
  op protocol is at version 4; an older host simply never receives the newer
  commands.
- A partial `clearRect` is now correct: a chunk flagged `NEEDS_LAYER` is
  replayed into its own `saveLayer`, instead of erasing whatever sits under the
  canvas into a black band. A full-canvas `clearRect` remains the signal that
  discards the retained display list; going 240 frames without one warns once.
- `arcTo` is a corner fillet between two segments, which Flutter's SVG-style
  `arcToPoint` cannot express — a rounded rectangle came out as a barrel. The
  tangent points are computed in JS now, so the host only ever receives
  `lineTo` + `arc`. `PathCmd.arcTo` keeps its slot (the numbering is fixed in
  `canvas_ops.dart`, and `fjs dev` can attach any older bundle to any client):
  it warns once and draws the corner as a polyline.
- `height: 100%` resolves inside a column whose height is known. Flutter's
  `Flex` hands children unbounded main-axis constraints by design, so a
  percentage resolved against `infinity` and degraded to `auto` — and a child
  that degraded while containing its own flex (a `<canvas>` surface, a nested
  column) hit "RenderFlex children have non-zero flex but incoming height
  constraints are unbounded". `buildFlex` now passes its own content box down
  to children that declare a main-axis percentage; children without one keep
  the unbounded constraints, and an unbounded box (inside a scroller) still
  degrades to `auto`.
- Percentages resolve for absolutely positioned children too. `RenderStack`
  hands `BoxConstraints()` unless an opposite edge or an explicit size is set,
  so `position: absolute` with `width/height: 100%` collapsed a full-screen
  overlay to one line of text; sizes are now resolved in place against the
  space the positioned box was given.
- `Expanded` became `Flexible(fit: bounded ? tight : loose)`. A tight fit is
  only legal when there is free space to hand out, so it asserted inside a
  shrink-wrapping column; CSS has no such failure — `flex-grow` with no free
  space simply does nothing.
- Style lengths accept `%` and `calc()` on `width` / `height` / `min-*` /
  `max-*`. The expression reduces to a px term plus a percentage term and is
  resolved in a `LayoutBuilder`; an unbounded axis degrades to `auto`, as in
  CSS. Percentages on other properties are still unsupported.
- Local images: `<image src>` resolves project assets, from the `fjs dev`
  server in development and from the bundled asset in release.
- `MirrorNode` is exported from `package:flutter_fjs/flutter_fjs.dart`. Writing a
  `ComponentBuilder` — the Flutter widget behind a JS tag — means reading the
  node it is handed, so the type is now part of the public surface. This is what
  an fjs module's widget extension is built on.
- `FjsEngine.devUri` / `devFetch(path)` expose the connected `fjs dev` server,
  and `fetch(url)` / `fetchString(url)` make one-off requests over the same
  HttpClient that backs JS `fetch()`. A module that ships a build-time file (an
  icon set, a language pack) can now read it from the dev server in dev and from
  its asset in release without an `FJS_DEV` dart-define or an HttpClient of its
  own. One engine now means one `HttpClient`: the dev-server connection shares
  it too, instead of opening a second one to the same host.

## 0.1.1

- Android natives are now 16 KB page aligned, as required by Android 15+ devices
  with 16 KB memory pages. `tool/build-android.sh` refuses NDKs older than r28,
  which is where that alignment became the default.

## 0.1.0

- First release.
- QuickJS-ng embedded via Dart FFI, JSI-style direct JS↔C++ calls.
- Source bundles and precompiled QuickJS bytecode bundles.
- HTML-like JS tags rendered as Flutter widgets; Vue 3 custom renderer support
  through the `@ufjs/runtime` npm package.
- Ships prebuilt natives: `libfjs.so` for `armeabi-v7a`, `arm64-v8a`, `x86_64`,
  and `fjs.xcframework` for iOS device, iOS simulator, and macOS — no NDK,
  CMake, or native compile step in consumer builds.
