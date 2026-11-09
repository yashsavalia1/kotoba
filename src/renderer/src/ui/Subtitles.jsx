import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

const isMined = (mined, t) => mined.has(t.lemma) || mined.has(t.text);

function Popup({ anchor, token, mined, onEnter, onLeave, onMine }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });

  useLayoutEffect(() => {
    const box = ref.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - box.width / 2), window.innerWidth - box.width - 8);
    const above = anchor.top - box.height - 10;
    setPos({ left, top: above > 8 ? above : Math.min(anchor.bottom + 10, window.innerHeight - box.height - 8) });
  }, [anchor, token]);

  return (
    <div ref={ref} className="popup" style={pos} onMouseEnter={onEnter} onMouseLeave={onLeave} data-testid="dict-popup" role="dialog" aria-label={`Dictionary: ${token.text}`}>
      {token.entries.map((e) => (
        <div className="entry" key={e.id}>
          <div>
            <span className="hw">{e.kanji || e.reading}</span>
            {e.kanji && e.reading ? <span className="rd jp">{e.reading}</span> : null}
            {e.inflected ? <span className="infl jp">← {e.matchedForm}</span> : null}
            {isMined(mined, { lemma: e.headword, text: e.kanji || e.reading }) ? <span className="tag">mined</span> : null}
          </div>
          {e.pos?.length ? <div className="pos">{e.pos.slice(0, 4).join(' · ')}</div> : null}
          <ol>
            {e.senses.slice(0, 4).map((s, i) => (
              <li key={i}>{s.text.slice(0, 4).join('; ')}</li>
            ))}
          </ol>
        </div>
      ))}
      <div className="foot">
        <button className="btn primary small" onClick={() => onMine(token)}>Make cards</button>
        <span>
          or press <kbd>E</kbd>
        </span>
      </div>
    </div>
  );
}

/** The hoverable subtitle line. Tokens were segmented in main when the track loaded. */
export default function Subtitles({ tokens, refText, fontSize, mined, onMine, onHover }) {
  const [hover, setHover] = useState(null);
  const closeTimer = useRef(null);

  const open = (token, el) => {
    clearTimeout(closeTimer.current);
    setHover({ token, anchor: el.getBoundingClientRect() });
    onHover(token);
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setHover(null);
      onHover(null);
    }, 160);
  };
  const cancelClose = () => clearTimeout(closeTimer.current);

  // A new cue invalidates the popup: the old token is no longer on screen.
  useEffect(() => {
    setHover(null);
    onHover(null);
    return () => clearTimeout(closeTimer.current);
  }, [tokens]);

  if (!tokens?.length && !refText) return null;

  return (
    <>
      <div className="subs">
        {tokens?.length ? (
          <div className="subline jp" style={{ fontSize }} data-testid="subtitle-line" onDoubleClick={(e) => e.stopPropagation()}>
            {tokens.map((t, i) => {
              if (!t.entries.length) return <span key={i} className="tok">{t.text}</span>;
              const cls = `tok known${isMined(mined, t) ? ' mined' : ''}${hover?.token === t ? ' active' : ''}`;
              return (
                <span
                  key={i}
                  className={cls}
                  data-testid="token"
                  onMouseEnter={(e) => open(t, e.currentTarget)}
                  onMouseLeave={scheduleClose}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMine(t);
                  }}
                >
                  {t.text}
                </span>
              );
            })}
          </div>
        ) : null}
        {refText ? <div className="refline" style={{ fontSize: Math.round(fontSize * 0.55) }}>{refText}</div> : null}
      </div>
      {hover ? (
        <Popup anchor={hover.anchor} token={hover.token} mined={mined} onEnter={cancelClose} onLeave={scheduleClose} onMine={onMine} />
      ) : null}
    </>
  );
}
