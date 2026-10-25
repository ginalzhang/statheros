import type { CanvasDiagnosticsReport, CanvasObservation, CanvasObservationSummary } from '../shared/contracts';

function summary(observation: CanvasObservation): CanvasObservationSummary {
  const { diagnostics: _diagnostics, ...value } = observation;
  return structuredClone(value);
}

/** Memory-only troubleshooting data; copied only on an explicit user action. */
export class CanvasDiagnostics {
  private report: CanvasDiagnosticsReport = { version: 1, current: null, history: [], lastInvalidation: null, lastSelectionValidation: null };
  observe(observation: CanvasObservation): void {
    this.report.current = structuredClone(observation);
    this.report.history.push(summary(observation));
    this.report.history = this.report.history.slice(-8);
  }
  invalidated(reason: string, changed: string[], previous: CanvasObservationSummary | null, current: CanvasObservation): void {
    this.report.lastInvalidation = { reason, changed: [...changed], previous: previous ? structuredClone(previous) : null, current: summary(current) };
  }
  selectionValidated(value: Omit<NonNullable<CanvasDiagnosticsReport['lastSelectionValidation']>, 'panelIntersection'>): void {
    const a = value.selection, b = value.panelBounds;
    const x = a && b ? Math.max(a.x, b.x) : 0, y = a && b ? Math.max(a.y, b.y) : 0;
    const width = a && b ? Math.min(a.x + a.width, b.x + b.width) - x : 0;
    const height = a && b ? Math.min(a.y + a.height, b.y + b.height) - y : 0;
    this.report.lastSelectionValidation = structuredClone({ ...value, panelIntersection: width > 0 && height > 0 ? { x, y, width, height } : null });
  }
  snapshot(): CanvasDiagnosticsReport { return structuredClone(this.report); }
}
