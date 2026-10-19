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
const stage = (value: string) => { (window as unknown as { __foliaStage?: string }).__foliaStage = value; };
stage('entry');

/** 主包约 2 MB，个别 iOS WebView 上这个请求会挂住：先用 fetch 预取（可超时可换连接），再 import。 */
const PREFETCH_TIMEOUT_MS = 8000;
const bootChunkUrl = (): string | null => {
    const link = Array.from(document.querySelectorAll('link[rel="modulepreload"]'))
        .map(node => node.getAttribute('href') || '')
        .find(href => href.includes('/bootstrap-'));
    return link || null;
};

const prefetch = (url: string, timeoutMs: number): Promise<void> => new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); reject(new Error('prefetch timeout')); }, timeoutMs);
    fetch(url, { signal: controller.signal, cache: 'force-cache' })
        .then(response => (response.ok ? resolve() : reject(new Error('HTTP ' + response.status))))
        .catch(reject)
        .finally(() => clearTimeout(timer));
});

const boot = async () => {
    const chunk = bootChunkUrl();
    if (chunk) {
        try {
            stage('prefetch');
            await prefetch(chunk, PREFETCH_TIMEOUT_MS);
            stage('prefetched');
        } catch {
            try {
                stage('prefetch-retry');
                await prefetch(chunk + '?r=' + Date.now(), PREFETCH_TIMEOUT_MS);
                stage('prefetched-retry');
            } catch {
                stage('prefetch-failed');
            }
        }
    }
    try {
        await import('./bootstrap');
        stage('bootstrap-loaded');
    } catch (error) {
        stage('bootstrap-failed');
        console.error('[boot] bootstrap failed', error);
    }
};

void boot();
