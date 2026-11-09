import React, { useEffect, useState } from 'react';
import * as core from '../api/core.js';
import Icon from './icons.jsx';

function Text({ id, value, onSave, type = 'text', ...rest }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const commit = () => String(v) !== String(value ?? '') && onSave(type === 'number' ? Number(v) : v.trim());
  return <input id={id} type={type} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} {...rest} />;
}

const Row = ({ id, label, children }) => (
  <div className="set-row">
    <label htmlFor={id}>{label}</label>
    <div className="ctl">{children}</div>
  </div>
);

const Check = ({ id, label, checked, onChange }) => (
  <Row id={id} label={label}>
    <input id={id} type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
  </Row>
);

export default function Settings({ settings, status, onSave, onStatus, onClose, toast }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(null);
  const save = (patch) => onSave(patch);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const run = async (label, fn) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setBusy(null);
    }
  };

  const testAnki = () =>
    run('test', async () => {
      const s = await onStatus();
      toast(s.anki != null ? `Connected to AnkiConnect v${s.anki}` : 'Could not reach AnkiConnect at that URL. Is Anki running with the add-on installed?', s.anki == null);
    });
  const installTypes = () =>
    run('install', async () => {
      const r = await core.ankiSetup();
      toast(`Note types installed in deck “${r.deck}”.`);
    });
  const saveKey = (value) =>
    run('key', async () => {
      const on = await core.setApiKey(value);
      setKey('');
      await onStatus();
      toast(value ? (on ? 'API key saved to the keychain.' : 'Key saved, but Claude is still unavailable.') : 'Stored API key removed.');
    });

  const keyNote = status.hasStoredKey
    ? 'A key is stored, encrypted with the OS keychain.'
    : status.envKey
      ? 'Using ANTHROPIC_API_KEY from the environment.'
      : 'Not set. Contrast, Situation and Naturalness cards stay off.';

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings" data-testid="settings" role="dialog" aria-modal="true" aria-labelledby="settings-h">
        <header>
          <h2 id="settings-h">Settings</h2>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close settings (Esc)"><Icon name="close" /></button>
        </header>
        <div className="body">
          <section>
            <h3>Anki</h3>
            <Row id="s-deck" label="Deck">
              <Text id="s-deck" value={settings.deckName} onSave={(v) => save({ deckName: v || 'Kotoba' })} />
            </Row>
            <Row id="s-anki" label="AnkiConnect URL">
              <Text id="s-anki" type="url" value={settings.ankiConnect} onSave={(v) => save({ ankiConnect: v })} />
              <button className="btn" onClick={testAnki} disabled={!!busy}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
            </Row>
            <Row label="Status">
              <span><span className={`dot ${status.anki != null ? 'ok' : 'bad'}`} />{status.anki != null ? `Connected (v${status.anki})` : 'Not reachable'}</span>
              <span className="spacer" />
              <button className="btn" onClick={installTypes} disabled={!!busy || status.anki == null}>{busy === 'install' ? 'Installing…' : 'Install note types'}</button>
            </Row>
          </section>

          <section>
            <h3>Claude</h3>
            <Row id="s-key" label="API key">
              <input
                id="s-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={status.hasStoredKey ? '•••••••••••• (stored)' : 'sk-ant-…'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && key.trim() && saveKey(key.trim())}
              />
              <button className="btn" onClick={() => saveKey(key.trim())} disabled={!key.trim() || !!busy}>Save</button>
              {status.hasStoredKey ? <button className="btn danger" onClick={() => saveKey('')} disabled={!!busy}>Remove</button> : null}
            </Row>
            <Row label="">
              <span className="hint"><span className={`dot ${status.llm ? 'ok' : ''}`} />{keyNote}</span>
            </Row>
          </section>

          <section>
            <h3>Cards</h3>
            <Row id="s-lang" label="Target language">
              <Text id="s-lang" value={settings.targetLang} onSave={(v) => save({ targetLang: v || 'ja' })} style={{ flex: '0 0 80px' }} />
              <span className="hint">ISO code; picks the audio track to play and clip.</span>
            </Row>
            <Row id="s-pad" label="Clip padding">
              <Text id="s-pad" type="number" min={0} max={3} step={0.05} value={settings.clipPadding} onSave={(v) => save({ clipPadding: Number.isFinite(v) ? Math.max(0, v) : 0.25 })} style={{ flex: '0 0 80px' }} />
              <span className="hint">seconds before and after the line</span>
            </Row>
          </section>

          <section>
            <h3>Playback</h3>
            <Row id="s-font" label="Subtitle size">
              <input id="s-font" type="range" min={14} max={72} step={1} value={settings.subtitleFontSize} onChange={(e) => save({ subtitleFontSize: Number(e.target.value) })} />
              <span className="faint" style={{ width: 40 }}>{settings.subtitleFontSize}px</span>
            </Row>
            <Check id="s-hover" label="Pause while hovering a word" checked={settings.pauseOnHover} onChange={(v) => save({ pauseOnHover: v })} />
            <Check id="s-next" label="Autoplay next file" checked={settings.autoplayNext} onChange={(v) => save({ autoplayNext: v })} />
            <Check id="s-resume" label="Resume where I left off" checked={settings.resumePlayback} onChange={(v) => save({ resumePlayback: v })} />
          </section>

          <section>
            <h3>Tools</h3>
            <Row id="s-ffmpeg" label="ffmpeg path">
              <Text id="s-ffmpeg" value={settings.ffmpegPath} placeholder="Automatic" spellCheck={false} onSave={(v) => save({ ffmpegPath: v })} />
            </Row>
            <Row id="s-ffprobe" label="ffprobe path">
              <Text id="s-ffprobe" value={settings.ffprobePath} placeholder="Automatic" spellCheck={false} onSave={(v) => save({ ffprobePath: v })} />
            </Row>
            <Row label="">
              <span className="hint"><span className={`dot ${status.ffmpeg ? 'ok' : 'bad'}`} />{status.ffmpeg ? 'ffmpeg found' : 'ffmpeg not found: clips and embedded subtitles need it'}</span>
            </Row>
          </section>
        </div>
      </div>
    </div>
  );
}
