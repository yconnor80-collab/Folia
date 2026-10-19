import { OnlineProviderError } from '../../types/onlineMusic';

// src/services/onlineMusic/sodaTransport.ts
// 汽水音乐的请求边界。浏览器不直接碰 api.qishui.com：设备参数补齐、防爬签名、扫码和第三方解析都在
// Worker 的 /api/soda/* 里完成，前端只认同源路径（可用 VITE_SODA_API_BASE 覆盖）。

const getSodaApiBase = (): string => {
    const viteValue = typeof import.meta !== 'undefined' && import.meta.env?.MODE !== 'test'
        ? String((import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_SODA_API_BASE || '')
        : '';
    return (viteValue || '/api/soda').replace(/\/$/, '');
};

export const getSodaTransportAvailability = () => ({ configured: true } as const);

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let response: Response;
    try {
        response = await fetch(`${getSodaApiBase()}${path}`, { credentials: 'include', ...init });
    } catch (error) {
        throw new OnlineProviderError('network', `Soda API ${path} unreachable`, 'soda', error);
    }
    if (!response.ok) {
        throw new OnlineProviderError('network', `Soda API ${path} failed with ${response.status}`, 'soda');
    }
    try {
        return await response.json() as T;
    } catch (error) {
        throw new OnlineProviderError('invalid-response', `Soda API ${path} returned an unreadable body`, 'soda', error);
    }
};

const post = <T>(path: string, body: unknown): Promise<T> => request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
});

export type SodaSearchItem = {
    id: string;
    title: string;
    artist: string;
    album: string;
    cover: string;
    durationMs: number;
};

export type SodaSearchResult = {
    items: SodaSearchItem[];
    total?: number;
    hasMore?: boolean;
};

export type SodaTrackInfo = {
    url: string;
    playAuth?: string;
    title?: string;
    artist?: string;
    album?: string;
    cover?: string;
};

export type SodaQrInfo = {
    token: string;
    qrImage: string;
    expireTime: number;
    /** 创建二维码时下发的 Cookie，轮询必须带回（Worker 无状态）。 */
    cookie: string;
    scanApp: string;
};

export type SodaQrStatus = {
    /** new / scanned / confirmed / expired */
    status: string;
    sessionid: string;
};

/** 搜索：Worker 转发到 api.qishui.com/luna/search/track，并归一化成扁平结构。 */
export const requestSodaSearch = (query: string, limit: number, offset: number): Promise<SodaSearchResult> => (
    request<SodaSearchResult>(`/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`)
);

/** 取播放直链：Worker 用 AES-GCM 构造解析请求，返回 url + playAuth。 */
export const requestSodaTrack = (id: string): Promise<SodaTrackInfo> => (
    request<SodaTrackInfo>(`/track?id=${encodeURIComponent(id)}`)
);

/** 取登录二维码（扫描必须用抖音 App）。 */
export const requestSodaQr = (): Promise<SodaQrInfo> => request<SodaQrInfo>('/qr');

/** 轮询扫码状态；确认后带回 sessionid。 */
export const requestSodaQrStatus = (token: string, cookie: string): Promise<SodaQrStatus> => (
    post<SodaQrStatus>('/qr/status', { token, cookie })
);

/** 当前账号信息（需要 sessionid）。 */
export const requestSodaMe = (sessionid: string): Promise<any> => (
    request<any>(`/me?sessionid=${encodeURIComponent(sessionid)}`)
);

/** 当前账号的歌单（需要 sessionid）。 */
export const requestSodaPlaylists = (sessionid: string): Promise<any> => (
    request<any>(`/playlists?sessionid=${encodeURIComponent(sessionid)}`)
);
