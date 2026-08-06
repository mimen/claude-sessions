declare module "*.svg" {
  /** Bun's text loader keeps the published SVG markup inside the JavaScript bundle. */
  const source: string;
  export default source;
}
