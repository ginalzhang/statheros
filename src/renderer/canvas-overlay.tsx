import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { CanvasSelectionSession, Point, ProbeStatus, Rect } from '../shared/contracts';
import { rectangleBetween, screenRectToSurface, surfacePointToScreen } from '../shared/canvas-coordinates';

function useCanvasStatus(): { status: ProbeStatus | null; error: string | null } {
  const [status, setStatus] = useState<ProbeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const off = window.steady.onStatus(value => { if (active) setStatus(value); });
    void window.steady.status().then(value => { if (active) setStatus(value); }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; off(); };
  }, []);
  return { status, error };
}

/** This view has no camera controller. Only the physical pointer selects a rectangle. */
export function CanvasOverlay(): React.JSX.Element {
  const { status, error: statusError } = useCanvasStatus();
  const sessionRef = useRef<CanvasSelectionSession | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [approved, setApproved] = useState(false);
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ origin: Point; pointerId: number } | null>(null);
  const requestVersion = useRef(0);
  const initialSelectionHandled = useRef(false);
  const setup = status?.canvasSetup;
  // Bind this renderer to its original session; a delayed event cannot act on a replacement.
  if (!sessionRef.current && setup?.mode === 'mouse' && setup.sessionId && setup.displayId !== null && status) {
    sessionRef.current = { sessionId: setup.sessionId, generation: status.generation, displayId: setup.displayId };
  }
  const session = sessionRef.current;
  const current = Boolean(session && session.sessionId === setup?.sessionId && session.generation === status?.generation && setup?.mode === 'mouse');
  const display = status?.displays.find(item => item.id === session?.displayId);
  const surface = status?.canvasSurfaceBounds;

  const cancel = (): void => {
    if (!session || cancelling) return;
    initialSelectionHandled.current = true;
    requestVersion.current++;
    setCancelling(true); setPending(true); setError(null);
    void window.steady.cancelCanvas(session.sessionId).catch(cause => { setError(String(cause)); setPending(false); setCancelling(false); });
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelRef.current(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const position = (event: ReactPointerEvent<HTMLElement>): Point | null => {
    if (!display || !surface) return null;
    return surfacePointToScreen({ x: event.clientX, y: event.clientY }, surface, display.bounds);
  };
  const preview = useCallback((rect: Rect | null): void => {
    if (!session || !current || !surface || !display) return;
    const version = ++requestVersion.current;
    setPending(true); setApproved(false); setError(null);
    void window.steady.previewCanvas({ ...session, surfaceBounds: surface, rect }).then(() => {
      if (version === requestVersion.current) { setPending(false); setApproved(rect !== null); }
    }).catch(cause => {
      if (version === requestVersion.current) { setPending(false); setError(String(cause)); }
    });
  }, [session, current, surface, display]);
  useEffect(() => {
    if (!current || !surface || !display || cancelling || initialSelectionHandled.current || !setup?.initialSelection) return;
    // A suggestion is only a draft. The same session-scoped validation as a
    // physical drag must succeed before Use canvas becomes available.
    initialSelectionHandled.current = true;
    setDraft(setup.initialSelection);
    preview(setup.initialSelection);
  }, [current, surface, display, cancelling, setup?.initialSelection, preview]);
  const pointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault();
    if (!current || pending || event.button !== 0 || !event.isPrimary) return;
    const origin = position(event);
    if (!origin) return;
    initialSelectionHandled.current = true;
    requestVersion.current++; setApproved(false); setError(null);
    drag.current = { origin, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({ ...origin, width: 0, height: 0 });
  };
  const pointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault();
    const point = position(event);
    if (drag.current?.pointerId === event.pointerId && point) setDraft(rectangleBetween(drag.current.origin, point));
  };
  const pointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault();
    if (drag.current?.pointerId !== event.pointerId) return;
    const point = position(event);
    const origin = drag.current.origin;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (point) { const next = rectangleBetween(origin, point); setDraft(next); preview(next); }
  };
  const confirm = (): void => {
    if (!current || !session || !surface || !display || !approved || pending) return;
    setPending(true); setError(null);
    void window.steady.confirmCanvas({ ...session, surfaceBounds: surface }).catch(cause => { setError(String(cause)); setApproved(false); setPending(false); });
  };
  const localDraft = draft && surface ? screenRectToSurface(draft, surface) : null;
  const border = localDraft ? {
    left: localDraft.x, top: localDraft.y, width: localDraft.width, height: localDraft.height,
  } : undefined;
  const controls = setup?.selectionControlsBounds;
  const localControls = controls && surface ? screenRectToSurface(controls, surface) : null;
  const controlsStyle = current && localControls && display ? {
    left: localControls.x, top: localControls.y,
    width: localControls.width, height: localControls.height,
  } : null;
  const reviewingWorkspace = Boolean(setup?.initialSelection);
  return <main className="canvas-selector" aria-label={reviewingWorkspace ? 'Review suggested workspace' : 'Select canvas with mouse'}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
    onPointerCancel={() => { drag.current = null; setApproved(false); }}
    onDragStart={event => event.preventDefault()} onContextMenu={event => event.preventDefault()}>
    {border && <div className={`canvas-selection-border ${error ? 'invalid' : ''}`} style={border} aria-hidden="true" />}
    {controlsStyle && <section className="canvas-selector-controls" aria-label="Canvas selection controls" style={controlsStyle}
      onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}>
      <h1>{reviewingWorkspace ? 'Review suggested workspace' : 'Select your canvas'}</h1>
      <div className="canvas-selector-instructions">
        {reviewingWorkspace
          ? <p>Input is paused. Inspect the highlighted workspace or drag to replace it. It may include tabs, rulers, scrollbars, or the bottom info bar.</p>
          : <p>Input is paused. Drag a rectangle over the document or drawing viewport.</p>}
        {reviewingWorkspace && setup?.initialSelectionAdjusted && <p>The suggestion was reduced to keep the Steady panel outside it. Drag to adjust it.</p>}
        <p>Use at least 100 × 100 points and keep the Steady panel outside the rectangle.</p>
        {draft && <p role="status">{Math.round(draft.width)} × {Math.round(draft.height)} points</p>}
        {(error ?? statusError) && <p role="alert" className="error">{error ?? statusError}</p>}
        <p className="hint">Escape cancels. Setup ends paused; Resume when ready.</p>
      </div>
      <div className="settings-actions">
        <button onClick={confirm} disabled={!current || !surface || !display || !approved || pending}>Use canvas</button>
        <button onClick={() => { initialSelectionHandled.current = true; setDraft(null); preview(null); }} disabled={!current || !surface || !display || pending || !draft}>Retry</button>
        <button onClick={cancel} disabled={!session || cancelling}>Cancel</button>
      </div>
    </section>}
  </main>;
}

/** Main makes this window nonfocusable and click-through. */
export function CanvasOutline(): React.JSX.Element | null {
  const { status } = useCanvasStatus();
  const display = status?.displays.find(item => item.id === status.selectedDisplayId);
  const canvas = status?.canvas;
  const surface = status?.canvasSurfaceBounds;
  if (!display || !canvas || !surface) return null;
  const localCanvas = screenRectToSurface(canvas, surface);
  return <div className="canvas-outline" aria-hidden="true" style={{
    left: localCanvas.x, top: localCanvas.y,
    width: localCanvas.width, height: localCanvas.height,
  }}><span>{status.canvasSetup?.source === 'viewport' ? 'Drawing viewport' : 'Canvas'} · Resume required</span></div>;
}
