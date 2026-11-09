/**
 * <VideoSurface plan audioStream onStatus onError ...videoProps ref />
 *
 * The only way the UI renders media. `ref` is the raw HTMLVideoElement; currentTime and
 * duration are media time in every mode, and seeking is just `el.currentTime = t`.
 *
 *   plan         result of playbackPlan(id[, { audioStream }])
 *   audioStream  ffprobe stream index from plan.audio[].index (default plan.audioStream)
 *   onStatus     ({ mode: 'direct'|'stream', loading, error, reason }) on every change
 *   onError      (message: string), fatal only, after the direct→stream fallback was tried
 *   ...rest      passed straight to <video> (onPlay, onTimeUpdate, muted, className, …)
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

export const VideoSurface = forwardRef(function VideoSurface({ plan, audioStream, onStatus, onError, ...videoProps }, ref) {
  const video = useRef(null);
  useImperativeHandle(ref, () => video.current, []);
  const [failed, setFailed] = useState(null);
  const url = plan?.url;

  useEffect(() => {
    setFailed(null);
    onStatus?.({ mode: plan?.mode ?? null, loading: Boolean(plan), error: null, reason: plan?.reason ?? null });
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <video
      {...videoProps}
      ref={video}
      src={url}
      onLoadedData={(e) => {
        onStatus?.({ mode: plan.mode, loading: false, error: null, reason: plan.reason ?? null });
        videoProps.onLoadedData?.(e);
      }}
      onError={(e) => {
        const msg = e.currentTarget.error?.message || 'The player refused this file.';
        if (failed === msg) return;
        setFailed(msg);
        onStatus?.({ mode: plan?.mode ?? null, loading: false, error: msg, reason: plan?.reason ?? null });
        onError?.(msg);
      }}
    />
  );
});

export default VideoSurface;
