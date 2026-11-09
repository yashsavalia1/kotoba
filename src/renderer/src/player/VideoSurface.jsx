/**
 * <VideoSurface plan audioStream onStatus onError ...videoProps ref />
 *
 * The only way the UI renders media. `ref` is the raw HTMLVideoElement; currentTime and
 * duration are media time in every mode, and seeking is just `el.currentTime = t`.
 *
 *   plan         result of playbackPlan(id)
 *   audioStream  ffprobe stream index from plan.audio[].index (default plan.audioStream).
 *                Changing it keeps the position; it streams unless that track plays directly.
 *   onStatus     ({ mode: 'direct'|'stream', loading, error, reason }) on every change
 *   onError      (message: string), fatal only, after the direct→stream fallback was tried
 *   ...rest      passed straight to <video> (onPlay, onTimeUpdate, muted, className, …)
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { attachStream } from './mse.js';

export const VideoSurface = forwardRef(function VideoSurface({ plan, audioStream, onStatus, onError, ...videoProps }, ref) {
  const video = useRef(null);
  useImperativeHandle(ref, () => video.current, []);
  const [fallback, setFallback] = useState(false);
  const resume = useRef(null);

  const audio = plan?.audio.find((a) => a.index === (audioStream ?? plan.audioStream));
  const direct = !fallback && (audio ? audio.directPlayable : plan?.mode === 'direct');
  const mode = direct ? 'direct' : 'stream';
  const reason = direct ? null : fallback ? 'direct playback failed' : (audio?.reason ?? plan?.reason ?? null);
  const source = !plan ? null : direct ? plan.url : `${plan.streamUrl}?audio=${audio?.index ?? ''}`;

  const fail = (msg) => {
    onStatus?.({ mode, loading: false, error: msg, reason });
    onError?.(msg);
  };

  useEffect(() => {
    const el = video.current;
    if (!el || !source) return;
    const from = resume.current;
    resume.current = null;
    onStatus?.({ mode, loading: true, error: null, reason });
    let detach = null;
    if (direct) {
      el.src = source;
      if (from) {
        el.addEventListener('loadedmetadata', () => (el.currentTime = from.t), { once: true });
      }
    } else {
      detach = attachStream(el, { url: source, duration: plan.duration, startAt: from?.t ?? 0, onError: fail });
    }
    if (from?.playing) el.play().catch(() => {});
    return () => {
      resume.current = { t: el.currentTime, playing: !el.paused };
      if (detach) detach();
      else {
        el.removeAttribute('src');
        el.load();
      }
    };
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <video
      {...videoProps}
      ref={video}
      // Without CORS, Web Audio taps and canvas reads of kotoba://media come back silent/tainted.
      crossOrigin="anonymous"
      data-mode={mode}
      data-source={source ?? ''}
      onLoadedData={(e) => {
        onStatus?.({ mode, loading: false, error: null, reason });
        videoProps.onLoadedData?.(e);
      }}
      onError={(e) => {
        if (!e.currentTarget.getAttribute('src')) return;
        const msg = e.currentTarget.error?.message || 'The player refused this file.';
        if (direct) setFallback(true);
        else fail(msg);
      }}
    />
  );
});

export default VideoSurface;
