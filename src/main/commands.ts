import { ACTIONS, LOCAL_ACTIONS as SHARED_LOCAL_ACTIONS, type ActionID, type Point, type Rect } from '../shared/contracts';
import { containsPoint } from './canvas';

export const LOCAL_ACTIONS = SHARED_LOCAL_ACTIONS;
export type LocalActionID = ActionID | typeof LOCAL_ACTIONS[number];
export const ALL_CONTROLS: readonly LocalActionID[] = [...ACTIONS, ...LOCAL_ACTIONS];
export type GlobalBindings = Partial<Record<LocalActionID, string>>;
export const defaultBindings = (): GlobalBindings => ({ penToggle: 'F8', pause: 'F9' });
export interface ShortcutProfile { name: string; targetBundleId: string; shortcuts: Record<'undo' | 'redo' | 'brush' | 'toggleErase' | 'bigger' | 'smaller', string> }
export const kritaProfile = (): ShortcutProfile => ({ name: 'Krita', targetBundleId: 'org.krita', shortcuts: { undo: 'Command+Z', redo: 'Command+Shift+Z', brush: 'B', toggleErase: 'E', bigger: ']', smaller: '[' } });
export const isLocalAction = (value: unknown): value is LocalActionID => typeof value === 'string' && ALL_CONTROLS.includes(value as LocalActionID);
/** A tracked panel hit returns a semantic local command. Panel background consumes Click. */
/** First overlay surface (panel, preview, toolbar) under the tracked pointer, with its button hit. */
export function hitSurfaces(position: Point, surfaces: readonly { bounds: Rect; buttons: readonly { actionId: LocalActionID; rect: Rect }[] }[]): { inside: boolean; action: LocalActionID | null } {
  for (const surface of surfaces) { const hit = hitPanel(position, surface.bounds, surface.buttons); if (hit.inside) return hit; }
  return { inside: false, action: null };
}
export function hitPanel(position: Point, panel: Rect, buttons: readonly { actionId: LocalActionID; rect: Rect }[]): { inside: boolean; action: LocalActionID | null } {
  if (!containsPoint(panel, position)) return { inside: false, action: null };
  const local = { x: position.x - panel.x, y: position.y - panel.y };
  return { inside: true, action: buttons.find(button => containsPoint(button.rect, local))?.actionId ?? null };
}
export function validateBindings(value: unknown): GlobalBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid global bindings.');
  const result: GlobalBindings = {};
  const seen = new Set<string>();
  for (const [action, accelerator] of Object.entries(value)) {
    if (!isLocalAction(action) || typeof accelerator !== 'string' || accelerator.length > 100 || /[\r\n\0]/.test(accelerator)) throw new Error('Invalid global binding.');
    if (!accelerator.trim()) continue;
    const normalized = accelerator.trim().toLowerCase();
    if (seen.has(normalized)) throw new Error(`Duplicate global binding: ${accelerator}`);
    seen.add(normalized); result[action] = accelerator.trim();
  }
  return result;
}
export function validateProfile(value: unknown): ShortcutProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid shortcut profile.');
  const p = value as Record<string, unknown>;
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 || typeof p.targetBundleId !== 'string' || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(p.targetBundleId) || !p.shortcuts || typeof p.shortcuts !== 'object' || Array.isArray(p.shortcuts)) throw new Error('Invalid shortcut profile.');
  const shortcuts = p.shortcuts as Record<string, unknown>;
  const keys = Object.keys(kritaProfile().shortcuts);
  if (Object.keys(shortcuts).length !== keys.length || !keys.every(key => typeof shortcuts[key] === 'string' && (shortcuts[key] as string).length > 0 && (shortcuts[key] as string).length <= 100 && !/[\r\n\0]/.test(shortcuts[key] as string))) throw new Error('Invalid target shortcuts.');
  return { name: p.name.trim(), targetBundleId: p.targetBundleId, shortcuts: { ...shortcuts } as ShortcutProfile['shortcuts'] };
}
export function resolveBinding(action: LocalActionID, canvasSetup: boolean): LocalActionID { return action === 'penToggle' && canvasSetup ? 'markCorner' : action; }

export interface BindingBackend { register(accelerator: string, callback: () => void): boolean; unregister(accelerator: string): void }
/** Own only Steady's registrations. Failed accelerators remain visible and unchanged. */
export class GlobalBindingInstaller {
  private installed: string[] = [];
  constructor(private readonly backend: BindingBackend) {}
  install(bindings: GlobalBindings, dispatch: (action: LocalActionID) => void): string[] {
    const valid = validateBindings(bindings);
    this.clear();
    const conflicts: string[] = [];
    for (const [action, accelerator] of Object.entries(valid) as [LocalActionID, string][]) {
      let accepted = false;
      try { accepted = this.backend.register(accelerator, () => dispatch(action)); } catch { /* Invalid OS accelerators are visible conflicts. */ }
      if (accepted) this.installed.push(accelerator);
      else conflicts.push(`${action}: ${accelerator}`);
    }
    return conflicts;
  }
  clear(): void { for (const accelerator of this.installed) this.backend.unregister(accelerator); this.installed = []; }
}
