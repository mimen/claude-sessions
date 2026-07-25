/** Provider marks backed by LobeHub's published, unmodified SVG package. */
import { BRAND_ICON_SVGS } from "./brand-icons.ts";

export interface ProviderMark {
  /** Complete vendor SVG markup, embedded into main.js by Bun's text loader. */
  readonly svg: string;
  readonly label: string;
}

export const PROVIDER_MARKS: Readonly<Record<"anthropic" | "openai", ProviderMark>> = {
  anthropic: {
    svg: BRAND_ICON_SVGS.claudeColor,
    label: "Claude",
  },
  openai: {
    svg: BRAND_ICON_SVGS.openai,
    label: "OpenAI",
  },
};
