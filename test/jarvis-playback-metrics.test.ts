import { describe, expect, it } from 'vitest';
import { JarvisPlaybackMetrics } from '../src/renderer/jarvis-playback-metrics.js';

describe('Jarvis non-sensitive playback event telemetry', () => {
  it('captures first renderer playing event and true inter-segment event gaps only', () => {
    let now = 1000;
    const metric = new JarvisPlaybackMetrics(now, () => now);
    metric.queued(3);
    now += 140; metric.playing();
    now += 220; metric.ended();
    now += 85; metric.playing();
    now += 190; metric.ended();
    expect(metric.snapshot()).toMatchObject({
      firstPlayingEventMs: 140, interSegmentGapMs: [85],
      segmentsStarted: 2, segmentsFinished: 2, maxQueued: 3, failures: 0, elapsedMs: 635
    });
  });
  it('does not count synthesis failures as audible segments or retain user data', () => {
    let now = 0;
    const metric = new JarvisPlaybackMetrics(now, () => now);
    metric.queued(2);
    metric.failed();
    now = 20;
    const sample = metric.snapshot();
    expect(sample).toMatchObject({ firstPlayingEventMs: null, failures: 1, segmentsStarted: 0 });
    expect(JSON.stringify(sample)).not.toContain('conversation');
  });
});
