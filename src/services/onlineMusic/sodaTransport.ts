import { OnlineProviderError } from '../../types/onlineMusic';

// src/services/onlineMusic/sodaTransport.ts
// 汽水音乐的请求边界。浏览器不直接碰 api.qishui.com：设备参数补齐、防爬签名和第三方解析都在
// Worker 的 /api/soda/* 里完成，前端只认同源路径（可用 VITE_SODA_API_BASE 覆盖）。

const getSodaApiBase = (): string => {
    const viteValue = typeof import.meta !== 'undefined' && import.meta.env?.MODE !== 'test'
        ? String((import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_SODA_API_BASE || '')
        : '';
    return (viteValue || '/api/soda').replace(/\/$/, '');
};

export const getSodaTransportAvailability = () => ({ configured: true } as const);

const request = async <T>(path: string): Promise<T> => {
    let response: Response;
    try {
        response = await fetch(`${getSodaApiBase()}${path}`, { credentials: 'include' });
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

/** 搜索：Worker 转发到 api.qishui.com/luna/search/track，并归一化成扁平结构。 */
export const requestSodaSearch = (query: string, limit: number, offset: number): Promise<SodaSearchResult> => (
    request<SodaSearchResult>(`/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`)
);

/** 取播放直链：Worker 用 AES-GCM 构造解析请求，返回 url + playAuth。 */
export const requestSodaTrack = (id: string): Promise<SodaTrackInfo> => (
    request<SodaTrackInfo>(`/track?id=${encodeURIComponent(id)}`)
);
