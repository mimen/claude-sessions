/**
 * Published LobeHub SVGs, loaded as text so Bun embeds them instead of emitting asset URLs.
 * Package source: @lobehub/icons-static-svg@1.94.0 (MIT).
 */
import anthropicSvg from "@lobehub/icons-static-svg/icons/anthropic.svg";
import claudeColorSvg from "@lobehub/icons-static-svg/icons/claude-color.svg";
import claudeCodeSvg from "@lobehub/icons-static-svg/icons/claudecode.svg";
import openAiSvg from "@lobehub/icons-static-svg/icons/openai.svg";

export const BRAND_ICON_SVGS = {
  anthropic: anthropicSvg,
  claudeColor: claudeColorSvg,
  claudeCode: claudeCodeSvg,
  openai: openAiSvg,
} as const;
