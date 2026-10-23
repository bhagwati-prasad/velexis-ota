// The shadcn/ui `cn()` helper that components.json names (`"utils": "@/lib/utils"`, README §12): no server-only
// import, because the copied components in src/components/ui/ are client and server components alike.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names and lets the last conflicting Tailwind utility win (the shadcn/ui `cn` helper). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
