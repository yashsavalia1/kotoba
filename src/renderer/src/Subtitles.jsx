import React, { useEffect, useRef, useState } from 'react';

/** Popup anchored to a hovered token, flipped to stay on screen. */
function Popup({ anchor, token, onEnter, onLeave, onMine }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });

  useEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const box = el.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, anchor.left + anchor.width / 2 - box.width / 2),
      window.innerWidth - box.width - 8
    );
    const above = anchor.top - box.height - 10;
    setPos({ left, top: above > 8 ? above : anchor.bottom + 10 });
  }, [anchor, token]);

  return (
    <div
      ref={ref}
      className="popup"
      style={pos}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {token.entries.map((e) => (
        <div className="entry" key={e.id}>
          <div className="jp hw">
            {e.kanji || e.reading}
            {e.kanji && e.reading ? <span className="rd">　{e.reading}</span> : null}
            {e.inflected ? <span className="pos">　← {e.matchedForm}</span> : null}
          </div>
          <div className="pos">{e.pos.slice(0, 4).join(' · ')}</div>
          {e.senses.slice(0, 4).map((s, i) => (
            <div className="sense" key={i}>
              {i + 1}. {s.text.slice(0, 4).join('; ')}
            </div>
          ))}
        </div>
      ))}
      <div className="hint">
        <button className="primary" onClick={() => onMine(token)}>
          Make cards
        </button>
        <span> 　or press E</span>
      </div>
    </div>
  );
}

/**
 * The hoverable subtitle line. Tokens were segmented server-side when the track
 * loaded, so hovering costs nothing but a re-render.
 */
export default function SubOverlay({ tokens, minedWords, onMine, onHoverChange }) {
  const [hover, setHover] = useState(null); // { token, anchor }
  const closeTimer = useRef(null);

  const open = (token, el) => {
    clearTimeout(closeTimer.current);
    if (!token.entries.length) return;
    setHover({ token, anchor: el.getBoundingClientRect() });
    onHoverChange?.(token);
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setHover(null);
      onHoverChange?.(null);
    }, 160);
  };
  const cancelClose = () => clearTimeout(closeTimer.current);

  // A new cue invalidates the popup - the old token is no longer on screen.
  useEffect(() => {
    setHover(null);
    onHoverChange?.(null);
    return () => clearTimeout(closeTimer.current);
  }, [tokens]);

  if (!tokens?.length) return null;

  return (
    <>
      <div className="suboverlay">
        <div className="subline jp">
          {tokens.map((t, i) => {
            const known = t.entries.length > 0;
            const cls = ['tok', known && 'known', known && minedWords.has(t.lemma) && 'mined']
              .filter(Boolean)
              .join(' ');
            return (
              <span
                key={i}
                className={cls}
                onMouseEnter={(e) => known && open(t, e.currentTarget)}
                onMouseLeave={scheduleClose}
                onClick={() => known && onMine(t)}
              >
                {t.text}
              </span>
            );
          })}
        </div>
      </div>
      {hover ? (
        <Popup
          anchor={hover.anchor}
          token={hover.token}
          onEnter={cancelClose}
          onLeave={scheduleClose}
          onMine={onMine}
        />
      ) : null}
    </>
  );
}
