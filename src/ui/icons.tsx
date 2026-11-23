import React from 'react';

export type IconName = 'play' | 'pause' | 'prev' | 'next' | 'shuffle' | 'repeat' | 'repeat1' | 'volume' | 'mute' | 'down' | 'search' | 'fish' | 'note' | 'list' | 'close' | 'sun' | 'moon' | 'auto' | 'gear' | 'tune';

const PATHS: Record<IconName, React.ReactNode> = {
  play: <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" stroke="none" />,
  pause: <g fill="currentColor" stroke="none"><rect x="6.5" y="5" width="4" height="14" rx="1.4" /><rect x="13.5" y="5" width="4" height="14" rx="1.4" /></g>,
  prev: <g fill="currentColor" stroke="none"><path d="M18 6.2v11.6a.9.9 0 0 1-1.4.75L8.4 12.75a.9.9 0 0 1 0-1.5l8.2-5.8A.9.9 0 0 1 18 6.2Z" /><rect x="5" y="5.5" width="2.6" height="13" rx="1.1" /></g>,
  next: <g fill="currentColor" stroke="none"><path d="M6 6.2v11.6a.9.9 0 0 0 1.4.75l8.2-5.8a.9.9 0 0 0 0-1.5l-8.2-5.8A.9.9 0 0 0 6 6.2Z" /><rect x="16.4" y="5.5" width="2.6" height="13" rx="1.1" /></g>,
  shuffle: <g><path d="M3 7h3.2c2 0 3.2.9 4.3 2.6l3 4.8c1.1 1.7 2.3 2.6 4.3 2.6H21" /><path d="M3 17h3.2c1.5 0 2.5-.5 3.4-1.5M14.4 8.5c.9-1 1.9-1.5 3.4-1.5H21" /><path d="m18.5 4.5 2.5 2.5-2.5 2.5M18.5 14.5l2.5 2.5-2.5 2.5" /></g>,
  repeat: <g><path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19" /><path d="m16 3 3 3-3 3" /><path d="M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5" /><path d="m8 21-3-3 3-3" /></g>,
  repeat1: <g><path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19" /><path d="m16 3 3 3-3 3" /><path d="M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5" /><path d="m8 21-3-3 3-3" /><path d="M11.2 10.4 12.6 9.6v5" /></g>,
  volume: <g><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" fill="currentColor" stroke="none" /><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" /></g>,
  mute: <g><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" fill="currentColor" stroke="none" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></g>,
  down: <path d="m6 9.5 6 6 6-6" />,
  search: <g><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></g>,
  fish: <g><path d="M3 12c2.6-4.2 6.2-6 10-6 3.4 0 6.2 2.4 8 6-1.8 3.6-4.6 6-8 6-3.8 0-7.4-1.8-10-6Z" /><path d="M3 12 1 8.5M3 12l-2 3.5" /><circle cx="16.2" cy="10.6" r="1" fill="currentColor" stroke="none" /></g>,
  list: <g><path d="M4 6.5h11M4 12h11M4 17.5h7" /><path d="M17.5 14.5v-8l3.5 1" /><circle cx="15.8" cy="16.8" r="2.2" /></g>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  gear: <g><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></g>,
  sun: <g><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></g>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  auto: <g><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" /></g>,
  tune: <g><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2.2" /><circle cx="9" cy="17" r="2.2" /><path d="M4 12h16" opacity=".45" /></g>,
  note: <g><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></g>,
};

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name]}
    </svg>
  );
}
