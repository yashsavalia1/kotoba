import { invoke } from './ipc.js';

export const playbackPlan = (id) => invoke('playback:plan', id);
