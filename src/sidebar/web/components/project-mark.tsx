/**
 * The project's own icon, or a folder when it publishes none.
 *
 * Every row carries one, so a session keeps the same visual identity wherever it sits in the list.
 * T3's settled rows drop project identity entirely; keeping it costs one glyph and is what makes a
 * long tail of closed sessions still scannable by project.
 */
import type React from "react";
import { useEffect, useState } from "react";
import { FolderIcon } from "./icons.tsx";
import { cn } from "@/lib/utils";

export interface ProjectMarkProps {
  readonly faviconUrl: string | null;
  /** Drain the colour for rows that are no longer live, matching the row's own recession. */
  readonly muted?: boolean;
}

export function ProjectMark({ faviconUrl, muted = false }: ProjectMarkProps): React.ReactElement {
  const [failed, setFailed] = useState(false);
  // A row can be recycled onto a different session as the list refreshes; without this a single
  // broken icon would stick to whatever session later occupied that position.
  useEffect(() => setFailed(false), [faviconUrl]);

  if (faviconUrl && !failed) {
    return (
      <img
        alt=""
        className={cn(
          "size-3 shrink-0 rounded-[3px] object-cover",
          muted && "opacity-50 grayscale group-hover:opacity-80 group-hover:grayscale-0",
        )}
        loading="lazy"
        onError={() => setFailed(true)}
        src={faviconUrl}
      />
    );
  }

  return (
    <FolderIcon
      className={cn("size-3 shrink-0", muted ? "text-muted-foreground/40" : "text-muted-foreground/60")}
    />
  );
}
