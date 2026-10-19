import { OnlineProviderError } from '../../types/onlineMusic';
import type { AudioQualityPreference } from '../../types/onlineMusic';
import type { UnifiedSong } from '../../types';
import { getSodaTransportAvailability, requestSodaSearch, requestSodaTrack } from './sodaTransport';

// src/services/onlineMusic/sodaProvider.ts
// 汽水音乐（字节）的 provider：只有搜索与播放两条能力，没有登录、歌单和歌词。
// 搜索与直链都由 Worker 的 /api/soda/* 提供（前者匿名可用，后者走第三方解析服务），
// 所以这里不持有任何凭据，也没有扫码流程。

const durationOf = (raw: Record<string, unknown>): number => Math.max(0, Number(raw.durationMs) || 0);

/** 把 Worker 归一化过的搜索结果映射成 UnifiedSong。 */
export const normalizeSodaSong = (raw: unknown): UnifiedSong => {
    const item = (raw || {}) as Record<string, unknown>;
    const id = String(item.id || '').trim();
    if (!id) throw new OnlineProviderError('invalid-response', 'Soda track has no id', 'soda');
    return {
        id,
        name: String(item.title || ''),
        artists: [{ id: '', name: String(item.artist || '') }],
        album: {
            id: String(item.album || ''),
            name: String(item.album || ''),
            coverUrl: String(item.cover || ''),
        },
        durationMs: durationOf(item),
        sourceRef: { kind: 'online', providerId: 'soda', mediaId: id, providerData: {} },
    };
};

const pageOf = (items: UnifiedSong[], total: number | undefined, offset: number, limit: number, hasMore?: boolean) => ({
    items,
    total,
    hasMore: typeof hasMore === 'boolean' ? hasMore : items.length >= limit,
    nextOffset: offset + items.length,
});

export const sodaProvider: OnlineMusicProvider = {
    id: 'soda',
    displayName: '汽水音乐',
    shortName: '汽水',
    getAvailability: getSodaTransportAvailability,
    capabilities: {
        search: true,
        playback: true,
        lyrics: false,
        // 汽水没有账户体系：显式 false 才会被 omni 标成 requiresAccount=false，
        // 选平台时直接切换而不是拉起登录（否则会进扫码流程并报「登录错误」）。
        auth: false,
    },
    normalizeSong: normalizeSodaSong,
    search: {
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return pageOf([], 0, offset, limit, false);
            const result = await requestSodaSearch(query, limit, offset);
            const items = Array.isArray(result.items) ? result.items.map(normalizeSodaSong) : [];
            return pageOf(items, result.total, offset, limit, result.hasMore);
        },
    },
    playback: {
        async getSongDetail(id) {
            return normalizeSodaSong({ id });
        },
        async getAudioSource(song, quality) {
            const source = song.sourceRef;
            if (source?.kind !== 'online' || source.providerId !== 'soda') {
                throw new OnlineProviderError('unsupported', 'Song does not belong to Soda Music', 'soda');
            }
            const track = await requestSodaTrack(String(source.mediaId));
            if (!track?.url) {
                throw new OnlineProviderError('not-playable', 'Soda returned no playable url', 'soda');
            }
            return {
                url: track.url,
                fetchedAt: Date.now(),
                quality: quality as AudioQualityPreference,
            };
        },
        getAvailability() {
            return { state: 'unknown' as const };
        },
    },
};
