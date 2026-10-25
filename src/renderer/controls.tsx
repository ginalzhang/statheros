import { useEffect, useState } from 'react';

/** Continuous 0–100 % slider: the percentage follows the thumb; the engine setting is applied on release. */
export function Slider({ label, value, disabled, onCommit }: { label: string; value: number; disabled: boolean; onCommit: (value: number) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => { if (draft !== value) onCommit(draft); };
  return <label className="slider">
    <span className="slider-label"><span>{label}</span><span className="value cyan">{draft}%</span></span>
    <input type="range" min={0} max={100} step={1} value={draft} disabled={disabled} aria-valuetext={`${draft}%`} style={{ '--fill': `${draft}%` } as React.CSSProperties}
      onChange={event => setDraft(Number(event.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
  </label>;
}
