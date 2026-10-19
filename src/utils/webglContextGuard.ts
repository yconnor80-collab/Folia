// src/utils/webglContextGuard.ts
// WebGL 上下文丢失的全局兜底。
//
// 页面上同时存在多个 WebGL 画布（纸感背景 ×2、可视化器、歌词）。浏览器对同时存活的上文
// 数量有上限，超了或显存不足时会静默回收最旧的那个：画布不再绘制，但元素还在，看起来就是
// 一块纯黑。歌词动画期间画布最多，所以黑屏多半发生在这时候。
//
// 这里在 document 上捕获 webglcontextlost：
//   1. preventDefault() —— 只有拦住默认行为，浏览器才允许之后触发 webglcontextrestored；
//   2. 立刻把出事的 canvas 隐藏，露出下层/底色，而不是让一块黑矩形盖住画面；
//   3. 上下文恢复时再显示出来（Pixi 会重建资源，不需要我们重新初始化）。
// 歌词层自己还有 useLatticeLyricCanvas 的 onFailure 兜底（退回标题），两者互不冲突。

const LOST_ATTRIBUTE = 'data-webgl-lost';

let installed = false;

const isCanvas = (target: EventTarget | null): target is HTMLCanvasElement => (
    typeof HTMLCanvasElement !== 'undefined' && target instanceof HTMLCanvasElement
);

const hideCanvas = (canvas: HTMLCanvasElement): void => {
    if (canvas.getAttribute(LOST_ATTRIBUTE) === '1') return;
    canvas.setAttribute(LOST_ATTRIBUTE, '1');
    canvas.style.visibility = 'hidden';
};

const showCanvas = (canvas: HTMLCanvasElement): void => {
    if (canvas.getAttribute(LOST_ATTRIBUTE) !== '1') return;
    canvas.removeAttribute(LOST_ATTRIBUTE);
    canvas.style.visibility = '';
};

export const installWebglContextGuard = (): void => {
    if (installed || typeof document === 'undefined') return;
    installed = true;

    document.addEventListener('webglcontextlost', event => {
        if (!isCanvas(event.target)) return;
        // 允许浏览器在资源可用后恢复上下文；不拦的话 canvas 会永久黑着。
        event.preventDefault();
        hideCanvas(event.target);
        console.warn('[webgl] context lost, canvas hidden until restored');
    }, true);

    document.addEventListener('webglcontextrestored', event => {
        if (!isCanvas(event.target)) return;
        showCanvas(event.target);
        console.info('[webgl] context restored');
    }, true);
};

/** 测试与调试用：手动把某个画布当作丢失处理。 */
export const hideWebglCanvas = hideCanvas;
