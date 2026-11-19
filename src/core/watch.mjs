// Port of Mizune's RecentVideos and Progress rules: when a video counts as watched, when a
// sitting was only a look, and how progress is worded on library cards.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Few watch the credits: the last tenth counts as the end, at least 30 s and at most 5 min. */
export const finished = (seconds, duration) => duration > 0 && duration - seconds < clamp(duration / 10, 30, 300);

/** A sitting of `seconds` was only a look: under a minute, or a quarter of a short video. */
export const skimmed = (seconds, duration) => seconds < Math.min(60, duration / 4);

/** How much of a video is behind you, 0 to 1: a watched one counts whole, even when watched again. */
export const share = (position, duration, watched) => (watched ? 1 : duration > 0 ? clamp(position / duration, 0, 1) : 0);

export function timeLeft(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'Under a minute left';
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

/** A folder's line under its name: how many videos it has, and how many of those are watched. */
export function folderDetail(videos, watched) {
  if (!videos) return null;
  const count = videos === 1 ? '1 video' : `${videos} videos`;
  if (!watched) return count;
  return watched >= videos ? `${count} · all watched` : `${count} · ${watched} watched`;
}
