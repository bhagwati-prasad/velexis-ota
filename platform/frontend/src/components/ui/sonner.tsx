"use client";

import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/*
 * The shadcn/ui `sonner` toaster, which the CLI installs for "toast" in the new-york-v4 style. The CLI copy reads
 * the theme from `next-themes`; the portal has a light theme only (globals.css), so the theme is fixed here and
 * that dependency is left out.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
