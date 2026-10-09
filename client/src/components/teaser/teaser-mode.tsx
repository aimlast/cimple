/**
 * TeaserMode — tells the CIM renderers they are drawing a teaser page.
 *
 * The renderers draw exactly as in the CIM (INTEGRATION §2.7 rule 1); the
 * only teaser-specific rule is in TwoColumn: a column whose layout isn't a
 * teaser column type (text, a list, figures or highlights — never a chart or
 * a table) is left out. The server already refuses those layouts
 * (shared/teaser.ts validateTeaserLayout); this is the second lock.
 */
import { createContext, useContext, type ReactNode } from "react";

const TeaserModeContext = createContext(false);

export function TeaserModeProvider({ children }: { children: ReactNode }) {
  return <TeaserModeContext.Provider value={true}>{children}</TeaserModeContext.Provider>;
}

export function useTeaserMode(): boolean {
  return useContext(TeaserModeContext);
}
