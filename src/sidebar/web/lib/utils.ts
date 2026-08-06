import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional classes and resolve conflicting Tailwind utilities at component boundaries. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
