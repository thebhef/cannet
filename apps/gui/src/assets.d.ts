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
