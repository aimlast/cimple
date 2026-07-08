/**
 * SectionBoundary — per-section error containment for CIM rendering.
 *
 * The section renderers consume AI-generated layoutData directly; a single
 * wrong-typed field used to crash React and white-screen the ENTIRE CIM for
 * the buyer. Wrapping each section means a malformed one degrades to a quiet
 * placeholder while the rest of the document renders normally.
 */
import { Component, type ReactNode } from "react";

export class SectionBoundary extends Component<
  { sectionTitle?: string; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error(
      `[cim] Section "${this.props.sectionTitle ?? "unknown"}" failed to render:`,
      error,
    );
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6 text-center">
        <p className="text-sm text-muted-foreground">
          {this.props.sectionTitle
            ? `The "${this.props.sectionTitle}" section could not be displayed.`
            : "This section could not be displayed."}
        </p>
      </div>
    );
  }
}
