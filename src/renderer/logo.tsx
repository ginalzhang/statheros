/** Statheros bunny mark (Figma "Steady — 512 px tile", node 77-1331): mint head, cream inner ears. */
export function BunnyMark({ size = 28 }: { size?: number }): React.JSX.Element {
  return <svg className="bunny-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <ellipse cx="22" cy="18" rx="6.5" ry="15" transform="rotate(-6 22 18)" fill="#93CFBD" />
    <ellipse cx="42" cy="18" rx="6.5" ry="15" transform="rotate(6 42 18)" fill="#93CFBD" />
    <ellipse cx="22.4" cy="19" rx="2.6" ry="10" transform="rotate(-6 22 18)" fill="#F6E4B5" />
    <ellipse cx="41.6" cy="19" rx="2.6" ry="10" transform="rotate(6 42 18)" fill="#F6E4B5" />
    <ellipse cx="32" cy="43" rx="21" ry="16" fill="#93CFBD" />
    <circle cx="24.5" cy="40" r="2.2" fill="#2B302D" />
    <circle cx="39.5" cy="40" r="2.2" fill="#2B302D" />
    <path d="M29 46.5q3 2.6 6 0" fill="none" stroke="#2B302D" strokeWidth="1.4" strokeLinecap="round" />
  </svg>;
}

