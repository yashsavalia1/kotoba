import { probe } from './media.mjs';
import { pathOf } from './library.mjs';

/**
 * How the renderer should play a media file. `direct` streams the original bytes
 * through kotoba://media/<id>; Chromium demuxes and decodes them itself.
 */
export async function playbackPlan(id) {
  const abs = pathOf(id);
  const info = await probe(abs);
  const streams = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  return {
    mode: 'direct',
    url: `kotoba://media/${id}`,
    duration: Number(info.format?.duration) || null,
    video: video ? { codec: video.codec_name, width: video.width, height: video.height } : null,
    audio: streams
      .filter((s) => s.codec_type === 'audio')
      .map((s, i) => ({
        index: s.index,
        order: i,
        codec: s.codec_name,
        channels: s.channels,
        language: s.tags?.language ?? null,
        title: s.tags?.title ?? null,
        default: s.disposition?.default === 1,
      })),
    chapters: (info.chapters ?? []).map((c) => ({
      start: Number(c.start_time),
      end: Number(c.end_time),
      title: c.tags?.title ?? '',
    })),
  };
}
