import React, { useEffect } from 'react';
import Icon from './icons.jsx';

const MOD = window.kotoba?.platform === 'darwin' ? '⌘' : 'Ctrl+';

export const KEYMAP = [
  ['Playback', [
    ['Play / pause', 'Space', 'K'],
    ['Seek 5 s', '←', '→'],
    ['Seek 1 s / 30 s', '⇧←→', '⌥←→'],
    ['Seek 10 s', 'J', 'L'],
    ['Jump to 0–90 %', '0 … 9'],
    ['Volume', '↑', '↓'],
    ['Mute', 'M'],
    ['Speed down / up / reset', '[', ']', '='],
    ['Previous / next file', '<', '>'],
    ['Fullscreen', 'F', 'double-click'],
  ]],
  ['Subtitles', [
    ['Previous / next line', ',', '.'],
    ['Replay line', 'R'],
    ['Delay −/+ 100 ms', 'G', 'H'],
    ['Show / hide', 'S'],
    ['Peek at translation (hold)', 'I'],
    ['Cycle subtitle track', 'V'],
    ['Text size', '−', '+'],
    ['Make cards from hovered word', 'E', 'click'],
  ]],
  ['Window', [
    ['Open file', `${MOD}O`],
    ['Library', `${MOD}L`],
    ['Transcript / playlist', 'T', 'P'],
    ['Settings', `${MOD},`],
    ['Add cards (in card maker)', `${MOD}↵`],
    ['Close dialog / exit fullscreen', 'Esc'],
    ['This list', '?'],
  ]],
];

export default function Shortcuts({ onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' && e.key !== '?') return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts" role="dialog" aria-modal="true" aria-labelledby="keys-h">
        <header>
          <h2 id="keys-h">Keyboard shortcuts</h2>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close (Esc)" autoFocus><Icon name="close" /></button>
        </header>
        <div className="body">
          <div className="keys">
            {KEYMAP.map(([group, rows]) => (
              <React.Fragment key={group}>
                <h4>{group}</h4>
                {rows.map(([what, ...keys]) => (
                  <div className="k" key={what}>
                    <span>{what}</span>
                    <span>{keys.map((k) => (/^[a-z-]+$/.test(k) ? <span key={k} className="faint">{k}</span> : <kbd key={k}>{k}</kbd>))}</span>
                  </div>
                ))}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
