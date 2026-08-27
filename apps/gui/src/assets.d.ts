// Vite emits image imports as URLs. TypeScript needs ambient
// declarations for the file extensions we use.

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.svg" {
  const src: string;
  export default src;
}

declare module "*.svg?raw" {
  const content: string;
  export default content;
}

declare module "*.css?raw" {
  const content: string;
  export default content;
}

/// Plain-text import of a `.js` file — used to load the screenshot
/// harness's injected helpers (`shot-prelude.js`, which the Rust side
/// embeds with `include_str!`) into a test that drives them against the
/// real components. Text, never a module: it is evaluated by hand into
/// the page the way the harness evaluates it into a webview.
declare module "*.js?raw" {
  const src: string;
  export default src;
}
