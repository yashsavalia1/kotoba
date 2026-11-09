import React from 'react';

const P = {
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  prevLine: 'M6 6h2v12H6zM9.5 12 18 6v12z',
  nextLine: 'M16 6h2v12h-2zM6 6l8.5 6L6 18z',
  replay: 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
  prevFile: 'M6 6h2v12H6zm3 6 5-6v12zm5 0 5-6v12z',
  nextFile: 'M16 6h2v12h-2zm-1 6-5 6V6zm-5 0-5 6V6z',
  volume: 'M4 9v6h4l5 4V5L8 9zm12.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z',
  muted: 'M4 9v6h4l5 4V5L8 9zm12.6 3 2.7-2.7-1.1-1.1-2.7 2.7-2.7-2.7-1.1 1.1 2.7 2.7-2.7 2.7 1.1 1.1 2.7-2.7 2.7 2.7 1.1-1.1z',
  subs: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm2 8v2h7v-2zm9 0v2h3v-2zM6 10v2h3v-2zm5 0v2h7v-2z',
  transcript: 'M4 6h2v2H4zm4 0h12v2H8zm-4 5h2v2H4zm4 0h12v2H8zm-4 5h2v2H4zm4 0h12v2H8z',
  playlist: 'M3 6h12v2H3zm0 5h12v2H3zm0 5h8v2H3zm14-3v6l5-3z',
  fullscreen: 'M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z',
  exitFullscreen: 'M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z',
  back: 'M15.5 5 8.5 12l7 7-1.5 1.5L5.5 12 14 3.5z',
  settings:
    'M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7 7 0 0 0-1.7-1L15 3h-4l-.4 2.8a7 7 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.2 1.6 2 3.5 2.5-1a7 7 0 0 0 1.7 1L11 21h4l.4-2.8a7 7 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  close: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z',
  file: 'M6 2h8l6 6v14H6zm7 1.5V9h5.5z',
  folder: 'M3 5h7l2 2h9v12H3z',
  finder: 'M4 4h16v16H4zm2 2v12h12V6zm3 3h2v3H9zm4 0h2v3h-2zm-4.5 5.5c2 1.6 5 1.6 7 0l1 1.2c-2.6 2-6.4 2-9 0z',
  trash: 'M9 3h6l1 2h4v2H4V5h4zM6 8h12l-1 13H7z',
  search: 'M10 4a6 6 0 1 1-3.6 10.8L3.7 17.5l-1.4-1.4L5 13.4A6 6 0 0 1 10 4zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  keyboard: 'M3 6h18v12H3zm2 2v2h2V8zm3 0v2h2V8zm3 0v2h2V8zm3 0v2h2V8zm3 0v2h2V8zM5 11v2h2v-2zm3 0v2h2v-2zm3 0v2h2v-2zm3 0v2h2v-2zm3 0v2h2v-2zM7 14v2h10v-2z',
  speed: 'M12 4a9 9 0 0 0-7.8 13.5h15.6A9 9 0 0 0 12 4zm4.2 4.4-3 5.2a1.5 1.5 0 1 1-1.9-1.9z',
  audio: 'M12 3v10.6A4 4 0 1 0 14 17V7h4V3z',
  locate: 'M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7zm0 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  more: 'M5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
};

export default function Icon({ name, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d={P[name]} fillRule="evenodd" />
    </svg>
  );
}
