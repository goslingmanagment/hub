// Root tsc follows dashboard imports from SSR tests but excludes vite/client.
// Vite resolves these side-effect styles in the browser and in Vitest.
declare module "*.css" {}
