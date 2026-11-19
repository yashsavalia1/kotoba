import path from 'node:path';
import { probe } from './media.mjs';
import { pathOf } from './library.mjs';

// What Chromium (Electron 45) plays, by ffprobe container family, measured with
// scripts/verify-playback.mjs over the scripts/make-fixtures.mjs set. Other containers fail to
// open; other video codecs play as a black picture and other audio codecs as silence.
const PLAYS = {
  matroska: { video: ['h264', 'hevc', 'vp9', 'av1'], audio: ['aac', 'opus', 'vorbis', 'flac', 'mp3', 'pcm_s16le'] },
  webm: { video: ['vp9', 'av1'], audio: ['opus', 'vorbis'] },
  mp4: { video: ['h264', 'hevc', 'vp9', 'av1'], audio: ['aac', 'opus', 'flac', 'mp3', 'pcm_s16le'] },
  ogg: { video: [], audio: ['vorbis', 'opus', 'flac'] },
  mp3: { video: [], audio: ['mp3'] },
  flac: { video: [], audio: ['flac'] },
  aac: { video: [], audio: ['aac'] },
  wav: { video: [], audio: ['pcm_s16le'] },
};
// Pixel formats each video codec decodes in: no Hi10P h264, no 4:2:2 or 4:4:4.
const PIX = { h264: ['yuv420p', 'yuvj420p'], hevc: ['yuv420p', 'yuv420p10le'], vp9: ['yuv420p'], av1: ['yuv420p'] };
const NAMES = { h264: 'H.264', hevc: 'HEVC', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4 Part 2', prores: 'ProRes', theora: 'Theora', eac3: 'E-AC3', truehd: 'TrueHD' };
const named = (codec) => NAMES[codec] ?? codec.toUpperCase();

function family(info, abs) {
  const f = info.format?.format_name ?? '';
  if (f.startsWith('matroska')) return path.extname(abs).toLowerCase() === '.webm' ? 'webm' : 'matroska';
  if (f.startsWith('mov,mp4')) return 'mp4';
  return f;
}

/**
 * The streams of an ffprobe result that Chromium plays (null when none) and, when it won't
 * play all of the file, why. Whatever part plays still plays.
 */
export function playable(info, abs) {
  const plays = PLAYS[family(info, abs)];
  const v = info.streams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audios = info.streams?.filter((s) => s.codec_type === 'audio') ?? [];
  // Chromium plays the first audio track it can decode, whatever the default flags say.
  const a = audios.find((s) => plays?.audio.includes(s.codec_name));
  const videoOk = v && plays?.video.includes(v.codec_name) && PIX[v.codec_name].includes(v.pix_fmt);
  return {
    video: videoOk ? { codec: v.codec_name, width: v.width, height: v.height } : null,
    audio: a ? { index: a.index, codec: a.codec_name, language: a.tags?.language ?? null } : null,
    unsupported: !plays
      ? `${family(info, abs).toUpperCase()} files aren't supported`
      : v && !videoOk
        ? `${named(v.codec_name)} video${plays.video.includes(v.codec_name) ? ` (${v.pix_fmt})` : ''} isn't supported`
        : audios.length && audios[0] !== a
          ? `${named(audios[0].codec_name)} audio isn't supported`
          : null,
  };
}

/** How the renderer plays a media file: kotoba://media/<id> straight into <video>. */
export async function playbackPlan(id) {
  const abs = pathOf(id);
  const info = await probe(abs);
  return {
    url: `kotoba://media/${id}`,
    duration: Number(info.format?.duration) || null,
    ...playable(info, abs),
    chapters: (info.chapters ?? []).map((c) => ({
      start: Number(c.start_time),
      end: Number(c.end_time),
      title: c.tags?.title ?? '',
    })),
  };
}
