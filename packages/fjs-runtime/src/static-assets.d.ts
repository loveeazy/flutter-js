// Static files imported as modules — `import logo from '@/assets/x.png'`.
//
// The bundler turns those into a URL (ASSET_LOADERS in the toolchain's
// build.ts, and vite's own asset pipeline on the web), so the value is a
// string. A project's tsconfig says `"types": []` — the fjs globals are not
// the DOM's, and vite/client would drag them in — so nothing else declares
// these, and every app used to hand-write the same block.
//
// Kept in step with ASSET_LOADERS: the extensions the build knows how to
// emit are exactly the ones that typecheck.

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.jpeg' {
  const src: string;
  export default src;
}

declare module '*.gif' {
  const src: string;
  export default src;
}

declare module '*.webp' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}

declare module '*.woff2' {
  const src: string;
  export default src;
}
