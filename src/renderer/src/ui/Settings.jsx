import React, { useEffect, useState } from 'react';
import * as core from '../api/core.js';
import Icon from './icons.jsx';

function Text({ id, value, onSave, type = 'text', ...rest }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const commit = () => String(v) !== String(value ?? '') && onSave(type === 'number' ? Number(v) : v.trim());
  return <input id={id} type={type} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} {...rest} />;
}

const Row = ({ id, label, children, check = false }) => (
  <div className="set-row">
    <label htmlFor={id}>{label}</label>
    <div className={`ctl${check ? ' check' : ''}`}>{children}</div>
  </div>
);

const Check = ({ id, label, hint, checked, onChange, nested = false }) => (
  <Row id={id} label={nested ? <span className="nested">{label}</span> : label} check>
    <input id={id} type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
    {hint ? <span className="hint">{hint}</span> : null}
  </Row>
);

export default function Settings({ settings, status, onSave, onChooseRoot, onStatus, onClose, toast }) {
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
            <h3>Library</h3>
            <Row label="Media folder">
              <span className={settings.libraryRoot ? 'path' : 'faint'} title={settings.libraryRoot ?? undefined}>{settings.libraryRoot ?? 'No folder chosen'}</span>
              <span className="spacer" />
              <button className="btn" onClick={onChooseRoot}>{settings.libraryRoot ? 'Change…' : 'Choose…'}</button>
            </Row>
            <Check id="s-epnum" label="Number the episodes" hint="Shows each video's place in its folder on its thumbnail" checked={settings.episodeNumbers} onChange={(v) => save({ episodeNumbers: v })} />
            <Check id="s-tidy" label="Tidy up names" hint="Hides release tags like [Group] and 1080p, and shows episodes as Episode 1" checked={settings.tidyNames} onChange={(v) => save({ tidyNames: v })} />
          </section>

          <section>
            <h3>Watching</h3>
            <Check id="s-cw" label="Continue watching" hint="Shows the videos you stopped partway at the top of the library" checked={settings.continueWatching} onChange={(v) => save({ continueWatching: v })} />
            <Check id="s-progress" label="Show progress" hint="Shows what you've watched in the library" checked={settings.showProgress} onChange={(v) => save({ showProgress: v })} />
            {settings.showProgress ? (
              <>
                <Check nested id="s-checks" label="Checkmarks" hint="On watched videos, and on folders once every video in them is watched" checked={settings.progressChecks} onChange={(v) => save({ progressChecks: v })} />
                <Check nested id="s-vprog" label="Video progress" hint="A line along the foot of a video's picture, as far as you've got" checked={settings.videoProgress} onChange={(v) => save({ videoProgress: v })} />
                <Check nested id="s-fprog" label="Folder progress" hint="A slice for each video along the foot of a folder's picture" checked={settings.folderProgress} onChange={(v) => save({ folderProgress: v })} />
              </>
            ) : null}
          </section>

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
            <Check id="s-dup" label="Warn about duplicates" hint="Ask before adding a card the deck already has. Off, it's added again" checked={settings.warnDuplicates} onChange={(v) => save({ warnDuplicates: v })} />
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
              <span className="hint">ISO code; picks the subtitle track to mine.</span>
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
        </div>
      </div>
    </div>
  );
}
