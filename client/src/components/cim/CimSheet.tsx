/**
 * CimSheet — the one continuous piece of paper a CIM is printed on.
 * Sets the template's `--cimt-*` variables for everything inside and spaces
 * sections by the template's density. Hosts: builder canvas, view room,
 * print preview, settings previews.
 */
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { useThemeStyle } from "./CimDesignContext";

export const CimSheet = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { flow?: boolean }>(
  function CimSheet({ className, style, flow = true, children, ...rest }, ref) {
    const vars = useThemeStyle();
    return (
      <div
        ref={ref}
        className={cn("cim-doc cim-sheet", flow && "cim-flow", className)}
        style={{ ...vars, ...style }}
        {...rest}
      >
        {children}
      </div>
    );
  },
);
