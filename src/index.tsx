import { Buffer } from 'buffer';
import { installGlobalVisualizerFrameRateLimiter } from './utils/frameRateLimiter';
import { installWebglContextGuard } from './utils/webglContextGuard';
import { installConsoleLogCapture } from './utils/consoleLogBuffer';
import { installDebugModule } from './services/debug/debugModule';
import { installMemorySampleFeed } from './services/debug/memorySamples';
// import { installCoverSizeAudit } from './services/debug/coverSizeSamples';
// @ts-ignore
globalThis.Buffer = Buffer;
// First, so the debug overlay's console tab has the startup lines too - they are where a failure
// to reach a library or restore a session shows up.
installConsoleLogCapture();
// Right after it, so the startup lines reach the runtime log file too and not only the in-memory
// buffer. Both no-op off Electron. See services/debug/debugModule.ts.
installDebugModule();
installMemorySampleFeed();
// Cover size audit, left wired but switched off: it answered whether the provider CDNs honour the
// size in a cover URL - they do - and that is not a question worth re-asking every session. The
// collector and its panel are still in the tree, and `?probe=coverSizeAudit` still reaches them.
// To bring the tab back, uncomment this line and the four sites in DevDebugOverlay.tsx. It was dev
// only even then: a packaged build has nothing to do with the answer, so it should not pay the
// observer or the rows it retains.
// if (import.meta.env.DEV) installCoverSizeAudit();
installGlobalVisualizerFrameRateLimiter();
// 上下文被回收时把黑画布藏起来（歌词动画期间画布最多，黑屏多半来自这里）。
installWebglContextGuard();
// iOS 17.4+ 的音频会话：声明成 playback 才能切后台/锁屏继续放，且不会被其它 App 的提示音打断。
try {
    const audioSession = (navigator as Navigator & { audioSession?: { type?: string } }).audioSession;
    if (audioSession) audioSession.type = 'playback';
} catch { /* 老浏览器没有这个 API，忽略 */ }

// 启动阶段标记：卡住时兜底面板会把它显示出来，用来定位是哪一步没走完。
(window as unknown as { __foliaStage?: string }).__foliaStage = 'entry';
void import('./bootstrap').then(
    () => { (window as unknown as { __foliaStage?: string }).__foliaStage = 'bootstrap-loaded'; },
    error => { (window as unknown as { __foliaStage?: string }).__foliaStage = 'bootstrap-failed'; console.error('[boot] bootstrap failed', error); },
);
